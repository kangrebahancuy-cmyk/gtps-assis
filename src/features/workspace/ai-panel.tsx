"use client";

import { Check, Loader2, Square, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useChat } from "@/features/chat/chat-provider";
import { GenerationReport } from "@/features/chat/generation-report";
import { MarkdownRenderer } from "@/features/chat/markdown-renderer";
import { SourcesPanel } from "@/features/chat/sources-panel";
import { configuredProviders, PROVIDER_LABELS, selectableModels } from "@/lib/chat/models";
import type { StoredMessage } from "@/lib/chat/types";
import { actionDef, applyModes, makeTarget, planApply, runAiTask, validateTask, WORKSPACE_AI_ACTIONS, type AiResult, type AiTask, type ApplyMode, type WorkspaceAiAction } from "@/lib/workspace/ai-task";
import type { WorkspaceController } from "@/lib/workspace/controller";
import { textOf, type WorkspaceFile } from "@/lib/workspace/types";
import type { SyntaxProblem } from "@/lib/workspace/validation";
import { aiClient } from "@/services/ai-client";
import type { ProviderId } from "@/types/ai";
import type { ScriptCheck } from "@/types/lua";

import { DiffView } from "./diff-view";
import type { EditorHandle, EditorSelection } from "./editor-types";

const SELECT_CLASS = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs";
const APPLY_LABEL: Record<ApplyMode, string> = { "replace-selection": "Replace selection", "replace-file": "Replace whole file", insert: "Insert at cursor" };

type Run =
  | { status: "idle" }
  | { status: "running"; task: AiTask; text: string }
  | { status: "done"; task: AiTask; result: Extract<AiResult, { ok: true }>; fileId: string }
  | { status: "error"; message: string; partial: string };

interface Applied {
  fileId: string;
  fileName: string;
  before: string;
  after: string;
}

interface AiPanelProps {
  workspace: WorkspaceController;
  file: WorkspaceFile;
  handle: EditorHandle | null;
  selection: EditorSelection;
  syntaxProblems: readonly SyntaxProblem[];
  /** A documentation check of this file that is still current (not changed since), or null. */
  docsCheck: ScriptCheck | null;
  onClose(): void;
  onMessage(text: string): void;
}

export function AiPanel({ workspace, file, handle, selection, syntaxProblems, docsCheck, onClose, onMessage }: AiPanelProps) {
  const { state: chat } = useChat();
  const prefs = workspace.getState().ai;
  const [action, setAction] = useState<WorkspaceAiAction>("explain");
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<Run>({ status: "idle" });
  const [applied, setApplied] = useState<Applied | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const providers = configuredProviders(chat.models.providers);
  const provider = (prefs && providers.some((p) => p.provider === prefs.provider) ? prefs.provider : "") as ProviderId | "";
  const models = selectableModels(chat.models.catalogs, provider || null);
  const model = prefs && provider && models.some((m) => m.id === prefs.model) ? prefs.model : (models[0]?.id ?? "");

  const def = actionDef(action);
  const hasSelection = selection.text.trim() !== "";
  const scopeLabel = !def.needsCode ? "Uses only your description" : hasSelection ? `Works on the selection (${selection.text.length} characters)` : "Works on the whole file (select code to limit it)";

  function choose(next: ProviderId | "") {
    if (next === "") return workspace.setAiPrefs(null);
    const first = selectableModels(chat.models.catalogs, next)[0]?.id ?? "";
    workspace.setAiPrefs({ provider: next, model: first });
  }

  async function start() {
    const current = workspace.file(file.id);
    if (!current) return;
    const text = textOf(current);
    const live = handle?.getSelection() ?? selection;
    const task: AiTask = {
      action,
      instruction,
      target: makeTarget(current.name, text, live),
      syntaxProblems,
      docsCheck,
    };
    const invalid = validateTask(task);
    if (invalid) {
      setRun({ status: "error", message: invalid, partial: "" });
      return;
    }
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setApplied(null);
    setApplyError(null);
    setRun({ status: "running", task, text: "" });
    const result = await runAiTask(aiClient, task, {
      provider: provider || undefined,
      model: provider ? model : undefined,
      signal: controller.signal,
      onText: (t) => setRun((r) => (r.status === "running" ? { ...r, text: t } : r)),
    });
    if (controller.signal.aborted && !result.ok) {
      setRun({ status: "error", message: "Stopped.", partial: result.partial });
      return;
    }
    setRun(result.ok ? { status: "done", task, result, fileId: file.id } : { status: "error", message: result.error.message, partial: result.partial });
  }

  function apply(mode: ApplyMode) {
    if (run.status !== "done" || !run.result.script) return;
    const current = workspace.file(run.fileId);
    if (!current) return setApplyError("That file no longer exists.");
    const before = textOf(current);
    const cursor = handle?.getSelection().end ?? before.length;
    const plan = planApply(mode, before, run.task, run.result.script, run.fileId === file.id ? cursor : before.length);
    if (!plan.ok) return setApplyError(plan.error);
    setApplyError(null);
    if (run.fileId === file.id && handle) {
      handle.replaceRange(plan.start, plan.end, plan.insert);
      // If the editor did not report the change, make sure the workspace has it anyway.
      if (textOf(workspace.file(run.fileId) ?? current) !== plan.next) workspace.edit(run.fileId, plan.next);
    } else workspace.edit(run.fileId, plan.next);
    setApplied({ fileId: run.fileId, fileName: current.name, before, after: plan.next });
    onMessage(`Applied to ${current.name}`);
  }

  function undo() {
    if (!applied) return;
    const current = workspace.file(applied.fileId);
    if (!current) return setApplyError("That file no longer exists.");
    const now = textOf(current);
    if (now !== applied.after) return setApplyError("The file changed after the AI edit, so it cannot be undone from here. Use Ctrl+Z in the editor.");
    if (applied.fileId === file.id && handle) {
      handle.replaceRange(0, now.length, applied.before);
      if (textOf(workspace.file(applied.fileId) ?? current) !== applied.before) workspace.edit(applied.fileId, applied.before);
    } else workspace.edit(applied.fileId, applied.before);
    setApplied(null);
    onMessage(`Undid the AI edit in ${applied.fileName}`);
  }

  function newFile() {
    if (run.status !== "done" || !run.result.script) return;
    const created = workspace.createFile(run.task.action === "generate" ? "generated" : `${file.name.replace(/\.lua$/i, "")}_${run.task.action}`, `${run.result.script}\n`);
    onMessage(`Created ${created.name}`);
  }

  const done = run.status === "done" ? run : null;
  const message = useMemo<StoredMessage | null>(() => {
    if (!done) return null;
    const now = Date.now();
    return {
      id: "workspace-ai",
      conversationId: "workspace",
      order: 1,
      role: "assistant",
      content: done.result.text,
      createdAt: now,
      updatedAt: now,
      status: "complete",
      provider: done.result.provider,
      model: done.result.model,
      meta: { ...(done.result.retrieval ? { docs: done.result.retrieval } : {}), ...(done.result.check ? { check: done.result.check } : {}) },
    };
  }, [done]);
  const modes = done ? applyModes(done.task) : [];
  const busy = run.status === "running";

  return (
    <aside aria-label="AI assistant" data-testid="ai-panel" className="flex h-full min-h-0 w-96 shrink-0 flex-col border-l border-border">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <h2 className="text-sm font-medium">AI assistant</h2>
        <Button size="icon" variant="ghost" className="size-7" aria-label="Close AI panel" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
        {chat.models.status === "unreachable" ? (
          <p role="alert" className="text-xs text-destructive">
            Can&apos;t reach the local backend.
          </p>
        ) : providers.length === 0 && chat.models.status === "ready" ? (
          <p role="note" className="text-xs text-muted-foreground">
            No AI provider is connected yet. Add a key in Settings → Providers.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-muted-foreground">
              Provider
              <select aria-label="AI provider" className={SELECT_CLASS} value={provider} onChange={(e) => choose(e.target.value as ProviderId | "")}>
                <option value="">Default (Settings)</option>
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {PROVIDER_LABELS[p.provider]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-foreground">
              Model
              <select aria-label="AI model" className={SELECT_CLASS} value={model} disabled={provider === ""} onChange={(e) => provider && workspace.setAiPrefs({ provider, model: e.target.value })}>
                {provider === "" ? <option value="">Default</option> : null}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        <div role="group" aria-label="AI action" className="flex flex-wrap gap-1">
          {WORKSPACE_AI_ACTIONS.map((a) => (
            <Button key={a.id} size="sm" variant={a.id === action ? "default" : "outline"} aria-pressed={a.id === action} disabled={busy} onClick={() => setAction(a.id)}>
              {a.label}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground" data-testid="ai-scope">
          {scopeLabel}. {def.mode === "generate" ? "The GTPS documentation is searched for every request." : "Answered from the GTPS documentation."}
        </p>

        {def.needsInstruction && (
          <label className="block text-xs text-muted-foreground">
            {def.instructionLabel}
            <textarea aria-label={def.instructionLabel} value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={3} disabled={busy} className="mt-1 w-full resize-y rounded-md border border-input bg-transparent p-2 text-sm text-foreground" />
          </label>
        )}

        <div className="flex gap-2">
          <Button size="sm" onClick={() => void start()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? "Working…" : `Run: ${def.label}`}
          </Button>
          {busy && (
            <Button size="sm" variant="outline" onClick={() => abort.current?.abort()}>
              <Square /> Stop
            </Button>
          )}
        </div>

        {run.status === "running" && (
          <p role="status" data-testid="ai-running" className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
            {run.text === "" ? "Searching the documentation and waiting for the answer…" : run.text.slice(-600)}
          </p>
        )}
        {run.status === "error" && (
          <div role="alert" data-testid="ai-error" className="text-xs text-destructive">
            <p>{run.message}</p>
            {run.partial && <p className="mt-1 text-muted-foreground">Partial answer received: {run.partial.slice(0, 200)}…</p>}
          </div>
        )}

        {done && message && (
          <div data-testid="ai-result" data-action={done.task.action} className="space-y-3">
            <p className="text-xs text-muted-foreground">
              {done.result.provider ? `${PROVIDER_LABELS[done.result.provider]} · ${done.result.model}` : "Answer"}
              {done.result.finishReason === "length" ? " · stopped at the length limit" : ""}
            </p>

            {actionDef(done.task.action).mode === "generate" ? (
              done.result.script ? (
                <>
                  {done.result.incomplete && (
                    <p role="alert" data-testid="ai-incomplete" className="text-xs text-destructive">
                      The answer was cut off inside the code, so this script is incomplete. It cannot be applied; run it again.
                    </p>
                  )}
                  <DiffView before={done.task.action === "generate" ? "" : done.task.target.code} after={done.result.script} />
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Apply the result">
                    {modes.map((m) => (
                      <Button key={m} size="sm" disabled={done.result.incomplete || (done.fileId !== file.id && m === "insert")} onClick={() => apply(m)}>
                        <Check /> {APPLY_LABEL[m]}
                      </Button>
                    ))}
                    <Button size="sm" variant="outline" disabled={done.result.incomplete} onClick={newFile}>
                      Save as new file
                    </Button>
                  </div>
                  {done.fileId !== file.id && <p className="text-xs text-muted-foreground">This result was made for another file. Switch back to it to apply here.</p>}
                  {done.task.target.kind === "selection" && done.task.action !== "generate" && (
                    <p className="text-xs text-muted-foreground" data-testid="selection-check-note">
                      The check below covers only the returned part. After you apply it, the Problems panel checks the whole file.
                    </p>
                  )}
                </>
              ) : (
                <p role="note" className="text-xs text-muted-foreground">
                  No script was found in the answer, so there is nothing to apply. The full answer is below.
                </p>
              )
            ) : null}

            {applyError && (
              <p role="alert" data-testid="apply-error" className="text-xs text-destructive">
                {applyError}
              </p>
            )}
            {applied && (
              <p role="status" data-testid="applied" className="flex items-center gap-2 text-xs">
                Applied to {applied.fileName}.
                <Button size="sm" variant="outline" className="h-6 px-2" onClick={undo}>
                  Undo
                </Button>
              </p>
            )}

            <SourcesPanel message={message} />
            <GenerationReport message={message} />
            <details open={actionDef(done.task.action).mode === "chat" || !done.result.script}>
              <summary className="cursor-pointer text-xs font-medium">Full answer</summary>
              <MarkdownRenderer source={done.result.text} className="mt-2 text-sm" />
            </details>
          </div>
        )}
      </div>

      <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground" data-testid="ai-disclaimer">
        AI output is not tested on a GTPS server. The checks here read the code (syntax, documentation); they never run it. Test every script on your own GTPS.
      </p>
    </aside>
  );
}
