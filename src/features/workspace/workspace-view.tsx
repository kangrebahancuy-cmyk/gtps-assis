"use client";

import { Archive, Copy, Download, FilePlus2, Maximize2, Minimize2, PackageOpen, Replace, Save, Search, Sparkles, Undo2, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { AiClientError, aiClient } from "@/services/ai-client";
import { useUiStore } from "@/store/ui-store";
import { readImportedFile } from "@/lib/workspace/files";
import { isDirty, textOf } from "@/lib/workspace/types";
import { checkSyntax, syntaxSummary, type SyntaxReport } from "@/lib/workspace/validation";
import { cn } from "@/lib/utils";

import { AiPanel } from "./ai-panel";
import { CodeEditor } from "./code-editor";
import { downloadText } from "./download";
import type { EditorEngine, EditorHandle, EditorSelection } from "./editor-types";
import { FileExplorer } from "./file-explorer";
import { ProblemsPanel, type DocsCheckState } from "./problems-panel";
import { TabBar } from "./tab-bar";
import { useWorkspace } from "./workspace-provider";

const NO_SELECTION: EditorSelection = { start: 0, end: 0, text: "" };

export interface WorkspaceViewProps {
  /** "basic" never loads Monaco (used by tests; the workspace itself falls back to it automatically). */
  engine?: "auto" | "basic";
  loadTimeoutMs?: number;
}

export function WorkspaceView({ engine, loadTimeoutMs }: WorkspaceViewProps = {}) {
  const { state, workspace } = useWorkspace();
  const theme = useUiStore((s) => s.theme);
  const [handle, setHandle] = useState<EditorHandle | null>(null);
  const [selection, setSelection] = useState<EditorSelection>(NO_SELECTION);
  const [engineInfo, setEngineInfo] = useState<{ engine: EditorEngine; reason: string | null }>({ engine: "loading", reason: null });
  const [fullscreen, setFullscreen] = useState(false);
  const [showFiles, setShowFiles] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [report, setReport] = useState<SyntaxReport | null>(null);
  const [docs, setDocs] = useState<DocsCheckState>({ status: "idle" });
  const [flash, setFlash] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const active = state.files.find((f) => f.id === state.activeId) ?? null;
  const text = active ? textOf(active) : "";
  const dirty = active ? isDirty(active) : false;
  const anyUnsaved = state.files.some(isDirty);

  const onEngine = useCallback((e: EditorEngine, reason: string | null) => setEngineInfo((prev) => (prev.engine === e && prev.reason === reason ? prev : { engine: e, reason })), []);

  const say = useCallback((message: string) => {
    setFlash(message);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(null), 4000);
  }, []);
  useEffect(() => () => void (flashTimer.current && clearTimeout(flashTimer.current)), []);

  // Basic syntax check, a moment after typing stops.
  useEffect(() => {
    if (!active) {
      setReport(null);
      return;
    }
    const timer = setTimeout(() => setReport(checkSyntax(text)), 250);
    return () => clearTimeout(timer);
  }, [active, text]);
  // A different file: the documentation result belongs to the old one.
  const activeId = state.activeId;
  useEffect(() => {
    setDocs({ status: "idle" });
    setSelection(NO_SELECTION);
  }, [activeId]);

  // Browsers warn before leaving only where an unsaved draft would really be lost (memory storage).
  useEffect(() => {
    if (!(anyUnsaved && state.storage === "memory")) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyUnsaved, state.storage]);

  const save = useCallback(async () => {
    if (!workspace || !active) return;
    const result = await workspace.save(active.id);
    say(result.ok ? `Saved ${active.name}` : result.error);
  }, [workspace, active, say]);

  async function copy() {
    const value = selection.text !== "" ? selection.text : text;
    try {
      await navigator.clipboard.writeText(value);
      say(selection.text !== "" ? `Copied the selection (${selection.text.length} characters)` : "Copied the whole file");
    } catch {
      say("Copy failed: the browser did not allow access to the clipboard.");
    }
  }

  function download() {
    if (!workspace || !active) return;
    const file = workspace.exportFile(active.id);
    if (!file) return;
    downloadText(file.name, file.text);
    say(`Downloaded ${file.name}${dirty ? " (including unsaved changes)" : ""}`);
  }

  async function importLua(files: FileList | null) {
    if (!workspace || !files || files.length === 0) return;
    const outcomes = await Promise.all([...files].map(async (f) => readImportedFile(f.name, new Uint8Array(await f.arrayBuffer()))));
    const summary = await workspace.importFiles(outcomes);
    setProblems(summary.failed);
    if (summary.imported.length > 0) say(`Imported ${summary.imported.join(", ")}`);
  }

  async function importProject(files: FileList | null) {
    const file = files?.[0];
    if (!workspace || !file) return;
    const result = await workspace.importProject(await file.text());
    if (result.ok) {
      setProblems([]);
      say(`Imported ${result.value.imported.length} file${result.value.imported.length === 1 ? "" : "s"} from the project`);
    } else setProblems([`${file.name}: ${result.error}`]);
  }

  async function checkDocs() {
    if (!active) return;
    const checked = text;
    setDocs({ status: "running" });
    try {
      const check = await aiClient.checkScript(checked);
      setDocs({ status: "done", check, stale: false });
      setCheckedText(checked);
    } catch (error) {
      setDocs({ status: "error", message: error instanceof AiClientError ? error.info.message : "The documentation check failed." });
    }
  }
  const [checkedText, setCheckedText] = useState("");
  const docsShown: DocsCheckState = docs.status === "done" ? { ...docs, stale: checkedText !== text } : docs;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      void save();
    } else if (event.key === "Escape" && fullscreen && !event.defaultPrevented && !(event.target as HTMLElement).closest?.('[role="search"], input, [role="dialog"]')) {
      setFullscreen(false);
    }
  }

  const status = useMemo(() => {
    if (!active) return "";
    if (report === null) return "Checking syntax…";
    return syntaxSummary(report);
  }, [active, report]);

  if (state.status === "loading") {
    return (
      <div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading workspace…
      </div>
    );
  }

  const ready = handle !== null && active !== null;

  return (
    <div
      data-testid="workspace"
      data-fullscreen={fullscreen}
      onKeyDownCapture={onKeyDown}
      className={cn("flex flex-col bg-background", fullscreen ? "fixed inset-0 z-50" : "h-full")}
    >
      <div role="toolbar" aria-label="Editor tools" className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" className="md:hidden" aria-expanded={showFiles} onClick={() => setShowFiles((v) => !v)}>
          Files
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!active || !dirty} title="Save (Ctrl+S)">
          <Save /> Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => active && workspace?.revert(active.id)} disabled={!dirty} title="Discard unsaved changes">
          <Undo2 /> Revert
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void copy()} disabled={!active} title="Copy the selection, or the whole file when nothing is selected">
          <Copy /> Copy
        </Button>
        <Button size="sm" variant="ghost" onClick={download} disabled={!active} title="Download this file as .lua">
          <Download /> Download .lua
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Button size="sm" variant="ghost" onClick={() => handle?.openFind(false)} disabled={!ready} title="Find">
          <Search /> Find
        </Button>
        <Button size="sm" variant="ghost" onClick={() => handle?.openFind(true)} disabled={!ready} title="Find and replace">
          <Replace /> Replace
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()} title="Import .lua files">
          <Upload /> Import
        </Button>
        <Button size="sm" variant="ghost" onClick={() => workspace && downloadText("gtps-lua-project.json", workspace.exportProject(), "application/json")} disabled={state.files.length === 0} title="Export every file as one project file">
          <Archive /> Export project
        </Button>
        <Button size="sm" variant="ghost" onClick={() => projectInput.current?.click()} title="Import a project file">
          <PackageOpen /> Import project
        </Button>
        <div className="ml-auto flex items-center gap-2">
          {dirty ? (
            <span data-testid="unsaved-badge" className="rounded bg-amber-500/15 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-300">
              Unsaved changes
            </span>
          ) : active ? (
            <span data-testid="saved-badge" className="text-xs text-muted-foreground">
              All changes saved
            </span>
          ) : null}
          <Button size="sm" variant={aiOpen ? "default" : "ghost"} aria-pressed={aiOpen} onClick={() => setAiOpen((v) => !v)} title="AI assistant: explain, fix, optimize, comment, refactor, modify, generate">
            <Sparkles /> AI
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setFullscreen((v) => !v)} aria-pressed={fullscreen} title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}>
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
            {fullscreen ? "Exit full screen" : "Full screen"}
          </Button>
        </div>
        <input ref={fileInput} type="file" accept=".lua,.txt" multiple hidden aria-label="Import Lua files" data-testid="import-input" onChange={(e) => { void importLua(e.target.files); e.target.value = ""; }} />
        <input ref={projectInput} type="file" accept=".json,application/json" hidden aria-label="Import project file" data-testid="import-project-input" onChange={(e) => { void importProject(e.target.files); e.target.value = ""; }} />
      </div>

      {state.storage === "memory" && (
        <p role="alert" data-testid="storage-warning" className="border-b border-border bg-amber-500/10 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-200">
          Files are not being stored on this device ({state.fallbackReason ?? "IndexedDB is unavailable"}). They are lost when this page closes: use Download or Export project to keep them.
        </p>
      )}
      {state.error && (
        <p role="alert" data-testid="storage-error" className="border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          {state.error}
        </p>
      )}
      {problems.length > 0 && (
        <div role="alert" data-testid="import-errors" className="flex items-start justify-between gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <ul>
            {problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          <button type="button" className="underline" onClick={() => setProblems([])}>
            Dismiss
          </button>
        </div>
      )}
      {engineInfo.engine === "basic" && engineInfo.reason && engine !== "basic" && (
        <p role="status" data-testid="engine-notice" className="border-b border-border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
          Using the basic editor (no syntax colouring): {engineInfo.reason} Syntax errors are still listed below.
        </p>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className={cn("w-56 shrink-0 border-r border-border", showFiles ? "block" : "hidden md:block")}>
          <FileExplorer
            files={state.files}
            activeId={state.activeId}
            onOpen={(id) => workspace?.openFile(id)}
            onCreate={(name) => workspace?.createFile(name)}
            onRename={(id, name) => workspace?.renameFile(id, name) ?? { ok: false, error: "Workspace not ready." }}
            onDelete={(id) => workspace?.deleteFile(id)}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <TabBar files={state.files} tabs={state.tabs} activeId={state.activeId} onSelect={(id) => workspace?.openFile(id)} onClose={(id) => workspace?.closeTab(id)} />
          <div className="min-h-[16rem] flex-1" data-testid="editor-area">
            {active && workspace ? (
              <CodeEditor
                engine={engine}
                loadTimeoutMs={loadTimeoutMs}
                onEngine={onEngine}
                path={active.id}
                value={text}
                theme={theme === "light" ? "light" : "dark"}
                onChange={(next) => workspace.edit(active.id, next)}
                onSave={() => void save()}
                onReady={setHandle}
                onSelection={setSelection}
                problems={report?.problems ?? []}
              />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                <p>No file is open.</p>
                <Button size="sm" onClick={() => workspace?.createFile("untitled")}>
                  <FilePlus2 /> New file
                </Button>
              </div>
            )}
          </div>

          <ProblemsPanel report={active ? report : null} docs={docsShown} canCheckDocs={active !== null && text.trim() !== ""} onCheckDocs={() => void checkDocs()} onGoTo={(line, column) => handle?.revealLine(line, column)} />

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-3 py-1 text-xs text-muted-foreground" data-testid="status-bar">
            <span data-testid="engine-label">Editor: {engineInfo.engine === "monaco" ? "Monaco" : engineInfo.engine === "basic" ? "basic" : "loading…"}</span>
            <span data-testid="syntax-status-bar">{status}</span>
            {selection.text !== "" && <span data-testid="selection-info">{selection.text.length} characters selected</span>}
            <span data-testid="storage-label">{state.storage === "indexeddb" ? "Stored on this device (IndexedDB)" : "Not stored (memory only)"}</span>
            <span role="status" data-testid="flash" className="ml-auto text-foreground">
              {flash}
            </span>
          </div>
        </div>

        {aiOpen && active && workspace && (
          <AiPanel
            workspace={workspace}
            file={active}
            handle={handle}
            selection={selection}
            syntaxProblems={report?.problems ?? []}
            docsCheck={docsShown.status === "done" && !docsShown.stale ? docsShown.check : null}
            onClose={() => setAiOpen(false)}
            onMessage={say}
          />
        )}
      </div>
    </div>
  );
}

