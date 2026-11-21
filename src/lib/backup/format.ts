/**
 * The backup file: ONE JSON file with everything the user created in this browser.
 *
 *   chats        conversations, messages, per-chat metadata, the documentation-search switch
 *   workspace    Lua files (saved text and unsaved drafts), open tabs, the AI model chosen for the workspace
 *   preferences  appearance, editor, sidebar and Markdown preferences
 *
 * NEVER included: API keys (they live only in the local backend's config file), the documentation source and
 * allowed-domain list, the documentation index and the scraper logs. Those belong to the local server, not to the
 * user's own data, and a backup file may be shared or stored somewhere less private.
 *
 * `checksum` is a SHA-256 over the `data` section. It detects a damaged, truncated or hand-edited file; it is not
 * a signature, so it does not prove who created the file.
 */
import { ImportError, parseExportValue } from "@/lib/chat/export";
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportedConversation } from "@/lib/chat/types";
import { parsePreferences, type Preferences } from "@/lib/preferences";
import { sanitizeLuaFileName } from "@/lib/workspace-files";
import type { AiPrefs, WorkspaceBackup } from "@/lib/workspace/controller";
import type { WorkspaceFile } from "@/lib/workspace/types";

export const BACKUP_FORMAT = "gtps-assistant-backup";
export const BACKUP_VERSION = 1;
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 500;
const MAX_FILE_TEXT = 1024 * 1024;

export interface BackupData {
  chats: { conversations: ExportedConversation[]; docsSearch: boolean };
  workspace: WorkspaceBackup;
  preferences: Preferences;
}

export interface BackupSummary {
  conversations: number;
  messages: number;
  files: number;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  createdAt: string;
  summary: BackupSummary;
  data: BackupData;
  checksum: { algorithm: "SHA-256"; value: string };
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const summarize = (data: BackupData): BackupSummary => ({
  conversations: data.chats.conversations.length,
  messages: data.chats.conversations.reduce((n, c) => n + c.messages.length, 0),
  files: data.workspace.files.length,
});

export async function buildBackup(data: BackupData, now = new Date()): Promise<BackupFile> {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    summary: summarize(data),
    data,
    checksum: { algorithm: "SHA-256", value: await sha256Hex(JSON.stringify(data)) },
  };
}

export const backupFileName = (now = new Date()): string => `gtps-assistant-backup-${now.toISOString().slice(0, 10)}.json`;

export interface ParsedBackup {
  createdAt: string;
  summary: BackupSummary;
  data: BackupData;
  /** Things that were repaired or ignored while reading (never errors). */
  warnings: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseFiles(raw: unknown, warnings: string[]): WorkspaceBackup {
  if (!isObject(raw)) throw new BackupError("The backup has no workspace section.");
  if (!Array.isArray(raw.files)) throw new BackupError("Workspace: the file list is missing.");
  if (raw.files.length > MAX_FILES) throw new BackupError(`Workspace: too many files (the limit is ${MAX_FILES}).`);
  const ids = new Set<string>();
  const names = new Set<string>();
  const files = raw.files.map((f, i): WorkspaceFile => {
    const where = `Workspace file ${i + 1}`;
    if (!isObject(f)) throw new BackupError(`${where} is not an object.`);
    if (typeof f.id !== "string" || f.id === "" || f.id.length > 200) throw new BackupError(`${where}: the id is not valid.`);
    if (ids.has(f.id)) throw new BackupError(`${where}: duplicate id.`);
    ids.add(f.id);
    if (typeof f.name !== "string" || f.name.trim() === "") throw new BackupError(`${where}: the name is missing.`);
    const name = sanitizeLuaFileName(f.name);
    if (name !== f.name) warnings.push(`File name "${f.name}" was changed to "${name}".`);
    if (names.has(name)) throw new BackupError(`${where}: another file is already called ${name}.`);
    names.add(name);
    if (typeof f.content !== "string" || f.content.length > MAX_FILE_TEXT) throw new BackupError(`${where} (${name}): the text is missing or too large.`);
    if (f.draft !== null && f.draft !== undefined && (typeof f.draft !== "string" || f.draft.length > MAX_FILE_TEXT)) throw new BackupError(`${where} (${name}): the unsaved text is not valid.`);
    const time = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return { id: f.id, name, content: f.content, draft: typeof f.draft === "string" ? f.draft : null, createdAt: time(f.createdAt), updatedAt: time(f.updatedAt) };
  });
  const tabs = Array.isArray(raw.tabs) ? raw.tabs.filter((t): t is string => typeof t === "string" && ids.has(t)) : [];
  const activeId = typeof raw.activeId === "string" && tabs.includes(raw.activeId) ? raw.activeId : (tabs[0] ?? null);
  const ai: AiPrefs | null = isObject(raw.ai) && typeof raw.ai.provider === "string" && typeof raw.ai.model === "string" ? { provider: raw.ai.provider.slice(0, 40), model: raw.ai.model.slice(0, 128) } : null;
  return { files, tabs, activeId, ai };
}

/**
 * Reads and VALIDATES a backup. Nothing is applied here. Any problem that makes the file untrustworthy
 * (not JSON, wrong format, newer version, checksum mismatch, malformed data) throws a BackupError whose message
 * is shown to the user as is.
 */
export async function parseBackup(text: string): Promise<ParsedBackup> {
  if (text.length > MAX_BACKUP_BYTES) throw new BackupError("The file is too large to be a backup.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError("This file is not valid JSON. It may be damaged or cut off.");
  }
  if (!isObject(raw) || raw.format !== BACKUP_FORMAT) throw new BackupError(isObject(raw) && raw.format === EXPORT_FORMAT ? "This is a chat export, not a full backup. Import it from Chat Preferences instead." : "This is not a GTPS Assistant backup file.");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version)) throw new BackupError("The backup has no valid version number.");
  if (raw.version > BACKUP_VERSION) throw new BackupError(`This backup was made by a newer version of GTPS Assistant (backup version ${raw.version}). Update the app to restore it.`);
  if (raw.version < 1) throw new BackupError(`Unsupported backup version ${raw.version}.`);
  if (!isObject(raw.data)) throw new BackupError("The backup has no data section.");
  const checksum = raw.checksum;
  if (!isObject(checksum) || checksum.algorithm !== "SHA-256" || typeof checksum.value !== "string") throw new BackupError("The backup has no checksum, so it cannot be verified.");
  if ((await sha256Hex(JSON.stringify(raw.data))) !== checksum.value) throw new BackupError("The checksum does not match: the file is damaged or was edited after it was created. It was not imported.");

  const warnings: string[] = [];
  const data = raw.data;
  if (!isObject(data.chats) || !Array.isArray(data.chats.conversations)) throw new BackupError("The backup has no chats section.");
  let conversations: ExportedConversation[];
  try {
    conversations = parseExportValue({ format: EXPORT_FORMAT, version: EXPORT_VERSION, conversations: data.chats.conversations });
  } catch (error) {
    throw new BackupError(`Chats: ${error instanceof ImportError ? error.message : "the data is not valid."}`);
  }
  const workspace = parseFiles(data.workspace, warnings);
  if (!isObject(data.preferences)) warnings.push("The backup has no preferences; defaults would be used if you restore them.");
  const parsed: BackupData = {
    chats: { conversations, docsSearch: data.chats.docsSearch !== false },
    workspace,
    preferences: parsePreferences(data.preferences),
  };
  return { createdAt: typeof raw.createdAt === "string" ? raw.createdAt.slice(0, 40) : "", summary: summarize(parsed), data: parsed, warnings };
}
