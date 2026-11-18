/**
 * The Lua workspace engine: files, open tabs, unsaved changes. Framework-free (React reads it
 * through useSyncExternalStore) so it can be tested in Node against the memory repository.
 *
 * Saved text (`content`) and unsaved text (`draft`) are kept apart. Drafts are written to the
 * repository a moment after typing stops, so closing the tab or reloading never loses an edit;
 * "Save" turns the draft into the saved content.
 */
import { newId } from "@/lib/chat/ids";
import { sanitizeLuaFileName, uniqueFileName, buildProject, downloadFileName, normalizeNewlines, parseProject, type ImportOutcome } from "./files";
import { isDirty, textOf, type Result, type WorkspaceFile, type WorkspaceRepository } from "./types";

export const STARTER_FILE_NAME = "main.lua";
export const STARTER_CONTENT = "-- main.lua\n-- Write your Lua here. Save with Ctrl+S.\n-- Use the AI panel to generate, explain or fix code.\n";

export interface AiPrefs {
  provider: string;
  model: string;
}

export interface WorkspaceState {
  status: "loading" | "ready";
  files: WorkspaceFile[];
  /** Open tabs, in order (file ids). */
  tabs: string[];
  activeId: string | null;
  storage: "indexeddb" | "memory";
  /** Why IndexedDB is not used (then files only live until the page closes). */
  fallbackReason: string | null;
  /** The last storage failure, if any (cleared by the next successful write). */
  error: string | null;
  ai: AiPrefs | null;
}

export const LOADING_STATE: WorkspaceState = { status: "loading", files: [], tabs: [], activeId: null, storage: "memory", fallbackReason: null, error: null, ai: null };

const META_TABS = "tabs";
const META_ACTIVE = "active";
const META_SEEDED = "seeded";
const META_AI = "ai";

export interface WorkspaceOptions {
  repository: WorkspaceRepository;
  fallbackReason?: string | null;
  now?: () => number;
  /** Delay before a draft is written to storage. Tests use 0 and call flush(). */
  draftDelayMs?: number;
  /** Files to start with instead of the starter file, the first time the workspace is opened (migration of the old localStorage workspace). */
  seedFiles?: ReadonlyArray<{ name: string; content: string }>;
}

export interface ImportSummary {
  imported: string[];
  failed: string[];
}

export class WorkspaceController {
  private state: WorkspaceState = LOADING_STATE;
  private listeners = new Set<() => void>();
  private repo: WorkspaceRepository;
  private now: () => number;
  private draftDelay: number;
  private dirtyDrafts = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Writes run one after another so the stored order always matches the order of actions. */
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private seedFiles: ReadonlyArray<{ name: string; content: string }>;

  constructor(options: WorkspaceOptions) {
    this.repo = options.repository;
    this.now = options.now ?? Date.now;
    this.draftDelay = options.draftDelayMs ?? 400;
    this.seedFiles = options.seedFiles ?? [];
    this.state = { ...LOADING_STATE, storage: options.repository.kind, fallbackReason: options.fallbackReason ?? null };
  }

  // ---- subscription (useSyncExternalStore) ----
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = (): WorkspaceState => this.state;
  private set(patch: Partial<WorkspaceState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // ---- loading ----
  async init(): Promise<void> {
    try {
      let files = await this.repo.listFiles();
      const seeded = (await this.repo.getMeta(META_SEEDED)) === "1";
      if (!seeded && files.length === 0) {
        const t = this.now();
        const names: string[] = [];
        const wanted = this.seedFiles.length > 0 ? this.seedFiles : [{ name: STARTER_FILE_NAME, content: STARTER_CONTENT }];
        const created = wanted.map((f): WorkspaceFile => {
          const name = uniqueFileName(names, f.name);
          names.push(name);
          return { id: newId("file"), name, content: normalizeNewlines(f.content), draft: null, createdAt: t, updatedAt: t };
        });
        await this.repo.putFiles(created);
        files = created;
      }
      if (!seeded) await this.repo.setMeta(META_SEEDED, "1");
      const ids = new Set(files.map((f) => f.id));
      const storedTabs = parseList(await this.repo.getMeta(META_TABS));
      const tabs = storedTabs === null ? files.slice(0, 1).map((f) => f.id) : storedTabs.filter((id) => ids.has(id));
      const storedActive = await this.repo.getMeta(META_ACTIVE);
      const activeId = storedActive && tabs.includes(storedActive) ? storedActive : (tabs[0] ?? null);
      this.set({ status: "ready", files, tabs, activeId, ai: parseAi(await this.repo.getMeta(META_AI)), error: null });
    } catch (error) {
      this.set({ status: "ready", files: [], tabs: [], activeId: null, error: `Could not read the workspace: ${messageOf(error)}` });
    }
  }

  /** Writes pending drafts and waits for every queued write. Call before leaving the page, and in tests. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.writePendingDrafts();
    await this.queue;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.writePendingDrafts();
    void this.queue.then(() => this.repo.close());
    this.listeners.clear();
  }

  // ---- reading ----
  file(id: string | null): WorkspaceFile | undefined {
    return id ? this.state.files.find((f) => f.id === id) : undefined;
  }
  active(): WorkspaceFile | undefined {
    return this.file(this.state.activeId);
  }
  hasUnsaved(): boolean {
    return this.state.files.some(isDirty);
  }

  // ---- tabs ----
  openFile(id: string): void {
    if (!this.file(id)) return;
    const tabs = this.state.tabs.includes(id) ? this.state.tabs : [...this.state.tabs, id];
    this.set({ tabs, activeId: id });
    this.saveTabs();
  }

  /** Closing a tab never discards edits: an unsaved draft stays with the file (shown with a dot in the file list). */
  closeTab(id: string): void {
    const index = this.state.tabs.indexOf(id);
    if (index < 0) return;
    const tabs = this.state.tabs.filter((t) => t !== id);
    const activeId = this.state.activeId === id ? (tabs[Math.min(index, tabs.length - 1)] ?? null) : this.state.activeId;
    this.set({ tabs, activeId });
    this.saveTabs();
  }

  // ---- files ----
  /** Creates a file (a free name is picked when `name` is taken) and opens it. */
  createFile(name = "untitled", content = ""): WorkspaceFile {
    const t = this.now();
    const file: WorkspaceFile = { id: newId("file"), name: uniqueFileName(this.names(), name), content: normalizeNewlines(content), draft: null, createdAt: t, updatedAt: t };
    this.set({ files: [...this.state.files, file], tabs: [...this.state.tabs, file.id], activeId: file.id });
    this.write(() => this.repo.putFiles([file]));
    this.saveTabs();
    return file;
  }

  renameFile(id: string, wanted: string): Result<string> {
    const file = this.file(id);
    if (!file) return { ok: false, error: "That file no longer exists." };
    if (wanted.trim() === "") return { ok: false, error: "Enter a file name." };
    const name = sanitizeLuaFileName(wanted);
    if (this.state.files.some((f) => f.id !== id && f.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `A file named ${name} already exists.` };
    if (name === file.name) return { ok: true, value: name };
    const renamed = { ...file, name };
    this.replace(renamed);
    this.dirtyDrafts.delete(id);
    this.write(() => this.repo.putFiles([renamed]));
    return { ok: true, value: name };
  }

  deleteFile(id: string): boolean {
    if (!this.file(id)) return false;
    const index = this.state.tabs.indexOf(id);
    const tabs = this.state.tabs.filter((t) => t !== id);
    const activeId = this.state.activeId === id ? (tabs[Math.min(Math.max(index, 0), tabs.length - 1)] ?? null) : this.state.activeId;
    this.dirtyDrafts.delete(id);
    this.set({ files: this.state.files.filter((f) => f.id !== id), tabs, activeId });
    this.write(() => this.repo.deleteFile(id));
    this.saveTabs();
    return true;
  }

  // ---- editing ----
  /** Records the editor text. The file becomes "unsaved" while it differs from the saved content. */
  edit(id: string, text: string): void {
    const file = this.file(id);
    if (!file || textOf(file) === text) return;
    this.replace({ ...file, draft: text === file.content ? null : text });
    this.dirtyDrafts.add(id);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.writePendingDrafts();
    }, this.draftDelay);
  }

  /** Saves the current text as the file's content. Resolves after the write has reached storage. */
  async save(id: string): Promise<Result<WorkspaceFile>> {
    const file = this.file(id);
    if (!file) return { ok: false, error: "That file no longer exists." };
    const text = textOf(file);
    const saved: WorkspaceFile = { ...file, content: text, draft: null, updatedAt: this.now() };
    this.dirtyDrafts.delete(id);
    try {
      await this.write(() => this.repo.putFiles([saved]));
    } catch (error) {
      return { ok: false, error: `Could not save ${file.name}: ${messageOf(error)}` };
    }
    // Keep anything typed while the write was running.
    const current = this.file(id);
    if (!current) return { ok: true, value: saved };
    const typedSince = textOf(current) !== text;
    const merged: WorkspaceFile = { ...current, content: text, updatedAt: saved.updatedAt, draft: typedSince ? textOf(current) : null };
    this.replace(merged);
    return { ok: true, value: merged };
  }

  async saveAll(): Promise<Result<number>> {
    let count = 0;
    for (const file of this.state.files.filter(isDirty)) {
      const r = await this.save(file.id);
      if (!r.ok) return r;
      count += 1;
    }
    return { ok: true, value: count };
  }

  /** Drops unsaved changes and goes back to the saved content. */
  revert(id: string): void {
    const file = this.file(id);
    if (!file || file.draft === null) return;
    const reverted = { ...file, draft: null };
    this.replace(reverted);
    this.dirtyDrafts.delete(id);
    this.write(() => this.repo.putFiles([reverted]));
  }

  // ---- import / export ----
  /** Adds the files that `readImportedFile` accepted. Existing files are never overwritten (a free name is used). */
  async importFiles(items: ImportOutcome[]): Promise<ImportSummary> {
    const summary: ImportSummary = { imported: [], failed: [] };
    const created: WorkspaceFile[] = [];
    const names = this.names();
    const t = this.now();
    for (const item of items) {
      if (!item.ok) {
        summary.failed.push(item.error);
        continue;
      }
      const name = uniqueFileName(names, item.name);
      names.push(name);
      created.push({ id: newId("file"), name, content: item.text, draft: null, createdAt: t, updatedAt: t });
      summary.imported.push(name);
    }
    if (created.length > 0) await this.addMany(created);
    return summary;
  }

  /** Reads a project file written by exportProject(). Existing files are never overwritten. */
  async importProject(text: string): Promise<Result<ImportSummary>> {
    const parsed = parseProject(text);
    if (!parsed.ok) return parsed;
    const names = this.names();
    const t = this.now();
    const created = parsed.files.map((f): WorkspaceFile => {
      const name = uniqueFileName(names, f.name);
      names.push(name);
      return { id: newId("file"), name, content: f.content, draft: null, createdAt: t, updatedAt: t };
    });
    if (created.length > 0) await this.addMany(created);
    return { ok: true, value: { imported: created.map((f) => f.name), failed: [] } };
  }

  /** The text to download for one file: what the editor shows now, including unsaved edits. */
  exportFile(id: string): { name: string; text: string } | null {
    const file = this.file(id);
    return file ? { name: downloadFileName(file.name), text: textOf(file) } : null;
  }

  exportProject(): string {
    return buildProject(this.state.files.map((f) => ({ name: f.name, content: textOf(f) })), new Date(this.now()));
  }

  // ---- preferences ----
  setAiPrefs(prefs: AiPrefs | null): void {
    this.set({ ai: prefs });
    this.write(() => this.repo.setMeta(META_AI, prefs ? JSON.stringify(prefs) : null));
  }

  // ---- internals ----
  private names(): string[] {
    return this.state.files.map((f) => f.name);
  }

  private replace(file: WorkspaceFile): void {
    this.set({ files: this.state.files.map((f) => (f.id === file.id ? file : f)) });
  }

  private async addMany(created: WorkspaceFile[]): Promise<void> {
    const last = created[created.length - 1]!;
    this.set({ files: [...this.state.files, ...created], tabs: [...this.state.tabs, ...created.map((f) => f.id)], activeId: last.id });
    this.saveTabs();
    try {
      await this.write(() => this.repo.putFiles(created)); // one atomic write for the whole import
    } catch {
      // write() already recorded the error in state
    }
  }

  private writePendingDrafts(): void {
    const files = [...this.dirtyDrafts].map((id) => this.file(id)).filter((f): f is WorkspaceFile => f !== undefined);
    this.dirtyDrafts.clear();
    if (files.length > 0) void this.write(() => this.repo.putFiles(files)).catch(() => {});
  }

  private saveTabs(): void {
    const { tabs, activeId } = this.state;
    void this.write(async () => {
      await this.repo.setMeta(META_TABS, JSON.stringify(tabs));
      await this.repo.setMeta(META_ACTIVE, activeId);
    }).catch(() => {});
  }

  /** Runs a storage write after the previous one; failures are recorded in `state.error` and re-thrown to the caller. */
  private write(run: () => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      try {
        await run();
        if (this.state.error?.startsWith("Could not")) this.set({ error: null });
      } catch (error) {
        if (!this.disposed) this.set({ error: `Could not write to storage: ${messageOf(error)}` });
        throw error;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseList(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function parseAi(raw: string | null): AiPrefs | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<AiPrefs>;
    return typeof v.provider === "string" && typeof v.model === "string" ? { provider: v.provider, model: v.model } : null;
  } catch {
    return null;
  }
}
