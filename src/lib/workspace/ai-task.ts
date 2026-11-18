/**
 * AI tasks of the Lua workspace: what is sent to the existing AI backend for "Explain / Fix / Optimize /
 * Add comments / Refactor / Modify / Generate", and how the answer is read. Everything except Explain goes
 * through the backend's generator mode, which ALWAYS searches the GTPS documentation (the prompt it writes
 * contains the retrieved excerpts and the documented API list) and checks the returned script afterwards.
 * Pure apart from the injected AI client, so it runs in Node tests.
 */
import { buildActionPrompt, type ScriptAction } from "@/lib/lua/actions";
import { extractScript } from "@/lib/lua/extract";
import type { AiErrorInfo, ChatRequest, ChatStreamEvent, FinishReason, ProviderId } from "@/types/ai";
import type { RetrievalInfo } from "@/types/rag";
import type { ScriptCheck } from "@/types/lua";
import type { SyntaxProblem } from "./validation";

export type WorkspaceAiAction = "explain" | "fix" | "optimize" | "comments" | "refactor" | "modify" | "generate";

export interface ActionDef {
  id: WorkspaceAiAction;
  label: string;
  /** "chat": a documentation-backed answer (no script is produced). "generate": returns a script that can be applied. */
  mode: "chat" | "generate";
  needsInstruction: boolean;
  /** Works on the selection (or the whole file). Generate works from the instruction alone. */
  needsCode: boolean;
  instructionLabel?: string;
}

export const WORKSPACE_AI_ACTIONS: readonly ActionDef[] = [
  { id: "explain", label: "Explain", mode: "chat", needsInstruction: false, needsCode: true },
  { id: "fix", label: "Fix", mode: "generate", needsInstruction: false, needsCode: true },
  { id: "optimize", label: "Optimize", mode: "generate", needsInstruction: false, needsCode: true },
  { id: "comments", label: "Add comments", mode: "generate", needsInstruction: false, needsCode: true },
  { id: "refactor", label: "Refactor", mode: "generate", needsInstruction: false, needsCode: true },
  { id: "modify", label: "Modify", mode: "generate", needsInstruction: true, needsCode: true, instructionLabel: "What should change?" },
  { id: "generate", label: "Generate", mode: "generate", needsInstruction: true, needsCode: false, instructionLabel: "Describe the script you want" },
];

export const actionDef = (id: WorkspaceAiAction): ActionDef => WORKSPACE_AI_ACTIONS.find((a) => a.id === id)!;

/** Longest piece of code sent to the model (the backend allows more; this keeps room for the documentation excerpts). */
export const MAX_AI_CODE_CHARS = 60_000;
const CONTEXT_LINES = 15;
const CONTEXT_CHARS = 2000;

/** The code an action works on: the selection when there is one, otherwise the whole file. */
export interface AiTarget {
  kind: "selection" | "file";
  /** Offsets of `code` in the file text when the request was made. */
  start: number;
  end: number;
  code: string;
  fileName: string;
  startLine: number;
  endLine: number;
  /** A few lines before and after a selection, for reference only. */
  before: string;
  after: string;
}

export function makeTarget(fileName: string, text: string, selection: { start: number; end: number }): AiTarget {
  const hasSelection = selection.end > selection.start && text.slice(selection.start, selection.end).trim() !== "";
  const start = hasSelection ? selection.start : 0;
  const end = hasSelection ? selection.end : text.length;
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length;
  const startLine = lineOf(start);
  const endLine = lineOf(Math.max(start, end - (text[end - 1] === "\n" ? 1 : 0)));
  const trim = (s: string) => s.replace(/^\n+|\n+$/g, "");
  const tailOf = (s: string) => trim(trim(s).split("\n").slice(-CONTEXT_LINES).join("\n").slice(-CONTEXT_CHARS));
  const headOf = (s: string) => trim(trim(s).split("\n").slice(0, CONTEXT_LINES).join("\n").slice(0, CONTEXT_CHARS));
  return {
    kind: hasSelection ? "selection" : "file",
    start,
    end,
    code: text.slice(start, end),
    fileName,
    startLine,
    endLine,
    before: hasSelection ? tailOf(text.slice(0, start)) : "",
    after: hasSelection ? headOf(text.slice(end)) : "",
  };
}

export interface AiTask {
  action: WorkspaceAiAction;
  instruction: string;
  target: AiTarget;
  /** Local syntax problems of the whole file (used by Fix). */
  syntaxProblems?: readonly SyntaxProblem[];
  /** A documentation check of the whole file that is still current (used by Fix). */
  docsCheck?: ScriptCheck | null;
}

/** A reason the task cannot be sent, or null. */
export function validateTask(task: AiTask): string | null {
  const def = actionDef(task.action);
  if (def.needsInstruction && task.instruction.trim() === "") return def.id === "generate" ? "Describe the script you want first." : "Say what should change first.";
  if (def.needsCode) {
    if (task.target.code.trim() === "") return "There is no code to work on: write some code or select it first.";
    if (task.target.code.length > MAX_AI_CODE_CHARS) return `This ${task.target.kind} is too long for the AI (${task.target.code.length.toLocaleString("en-US")} characters; the limit is ${MAX_AI_CODE_CHARS.toLocaleString("en-US")}). Select a smaller part.`;
  }
  return null;
}

const SCRIPT_ACTION: Record<Exclude<WorkspaceAiAction, "generate">, ScriptAction> = {
  explain: "explain",
  fix: "fix",
  optimize: "optimize",
  comments: "comments",
  refactor: "refactor",
  modify: "modify",
};

/** The user message sent to the backend. */
export function buildRequestText(task: AiTask): string {
  if (task.action === "generate") return task.instruction.trim();
  const { target } = task;
  const parts: string[] = [];
  if (target.kind === "selection") {
    parts.push(
      `The code below is a SELECTED PART (lines ${target.startLine}-${target.endLine}) of the file "${target.fileName}", not a whole script. Treat only this code as the script. Return the complete updated version of exactly this part so it can be pasted back in its place. Do not add or return code that belongs outside the selection.`,
    );
    if (target.before || target.after) {
      parts.push(`Surrounding code, for reference only (do not return it):\n\`\`\`text\n${target.before ? `--- before the selection ---\n${target.before}\n` : ""}${target.after ? `--- after the selection ---\n${target.after}\n` : ""}\`\`\``);
    }
  }
  if (task.action === "fix") {
    const inRange = (task.syntaxProblems ?? []).filter((p) => target.kind === "file" || (p.line >= target.startLine && p.line <= target.endLine));
    if (inRange.length > 0) {
      const offset = target.kind === "selection" ? target.startLine - 1 : 0;
      parts.push(`The local syntax check of the editor reports:\n${inRange.map((p) => `- line ${p.line - offset}: ${p.message}`).join("\n")}`);
    }
  }
  const check = task.action === "fix" && target.kind === "file" ? (task.docsCheck ?? undefined) : undefined;
  parts.push(buildActionPrompt(SCRIPT_ACTION[task.action], { code: target.code, check, instruction: task.instruction }));
  return parts.join("\n\n");
}

export function buildChatRequest(task: AiTask, choice: { provider?: ProviderId; model?: string } = {}): ChatRequest {
  const def = actionDef(task.action);
  return {
    mode: def.mode,
    ...(def.mode === "chat" ? { docs: true } : {}),
    ...(choice.provider ? { provider: choice.provider } : {}),
    ...(choice.provider && choice.model ? { model: choice.model } : {}),
    messages: [{ role: "user", content: buildRequestText(task) }],
  };
}

export interface AiStreamClient {
  streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent>;
}

export type AiResult =
  | {
      ok: true;
      text: string;
      /** The script in the reply (the longest lua block), when the action produces one. */
      script: string | null;
      /** The reply ended inside the code block (cut off), so the script is incomplete. */
      incomplete: boolean;
      retrieval: RetrievalInfo | null;
      check: ScriptCheck | null;
      provider: ProviderId | null;
      model: string | null;
      finishReason: FinishReason | null;
    }
  | { ok: false; error: AiErrorInfo | { kind: "cancelled" | "unknown"; message: string }; partial: string };

/** Sends a task and reads the whole streamed answer. `onText` receives the reply so far. */
export async function runAiTask(
  client: AiStreamClient,
  task: AiTask,
  options: { provider?: ProviderId; model?: string; signal?: AbortSignal; onText?: (text: string) => void } = {},
): Promise<AiResult> {
  const invalid = validateTask(task);
  if (invalid) return { ok: false, error: { kind: "unknown", message: invalid }, partial: "" };
  let text = "";
  let retrieval: RetrievalInfo | null = null;
  let check: ScriptCheck | null = null;
  let provider: ProviderId | null = null;
  let model: string | null = null;
  let finishReason: FinishReason | null = null;
  try {
    for await (const event of client.streamChat(buildChatRequest(task, options), options.signal)) {
      if (event.type === "start") {
        provider = event.provider;
        model = event.model;
      } else if (event.type === "context") retrieval = event.context;
      else if (event.type === "delta") {
        text += event.text;
        options.onText?.(text);
      } else if (event.type === "script_check") check = event.check;
      else if (event.type === "done") finishReason = event.finishReason;
      else if (event.type === "error") return { ok: false, error: event.error, partial: text };
    }
  } catch (error) {
    if (options.signal?.aborted) return { ok: false, error: { kind: "cancelled", message: "Cancelled." }, partial: text };
    const info = (error as { info?: AiErrorInfo }).info;
    return { ok: false, error: info ?? { kind: "unknown", message: error instanceof Error ? error.message : "The request failed." }, partial: text };
  }
  const block = actionDef(task.action).mode === "generate" ? extractScript(text) : null;
  return { ok: true, text, script: block?.code ?? null, incomplete: block ? !block.closed : false, retrieval, check, provider, model, finishReason };
}

// ---- applying a result ----

export type ApplyMode = "replace-selection" | "replace-file" | "insert";

export type ApplyPlan = { ok: true; start: number; end: number; insert: string; next: string } | { ok: false; error: string };

/** Which ways of applying make sense for this task (new file is always possible and handled by the caller). */
export function applyModes(task: Pick<AiTask, "action" | "target">): ApplyMode[] {
  if (task.action === "generate") return ["insert", "replace-file"];
  return task.target.kind === "selection" ? ["replace-selection", "insert"] : ["replace-file", "insert"];
}

/**
 * Works out the edit for an apply. Refuses when the code the AI worked on has changed since the request,
 * because the result was written for the old text and replacing would overwrite newer edits.
 */
export function planApply(mode: ApplyMode, current: string, task: Pick<AiTask, "action" | "target">, script: string, cursor: number): ApplyPlan {
  const { target } = task;
  const needsSame = actionDef(task.action).needsCode;
  const keepEnd = (replaced: string) => (replaced.endsWith("\n") && !script.endsWith("\n") ? `${script}\n` : script);
  if (mode === "replace-selection") {
    if (target.kind !== "selection") return { ok: false, error: "There was no selection." };
    if (current.slice(target.start, target.end) !== target.code) return { ok: false, error: "The selected code changed after the request. Select it again and ask again." };
    const insert = keepEnd(target.code);
    return { ok: true, start: target.start, end: target.end, insert, next: current.slice(0, target.start) + insert + current.slice(target.end) };
  }
  if (mode === "replace-file") {
    if (needsSame && target.kind === "file" && current !== target.code) return { ok: false, error: "The file changed after the request. Ask again to avoid overwriting newer edits." };
    const insert = script.endsWith("\n") ? script : `${script}\n`;
    return { ok: true, start: 0, end: current.length, insert, next: insert };
  }
  const at = Math.max(0, Math.min(cursor, current.length));
  const before = at > 0 && current[at - 1] !== "\n" ? "\n" : "";
  const after = at < current.length && current[at] !== "\n" ? "\n" : "";
  const insert = `${before}${script.replace(/\n$/, "")}\n${after}`;
  return { ok: true, start: at, end: at, insert, next: current.slice(0, at) + insert + current.slice(at) };
}
