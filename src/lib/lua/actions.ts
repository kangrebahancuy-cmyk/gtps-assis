import type { ScriptCheck } from "@/types/lua";

/**
 * The actions offered on every generated script. Copy, Download and Open in Workspace work on the code directly;
 * the others write a request that is sent through the generator (so the documentation workflow and the
 * script check run again on the result).
 */

export type ScriptAction = "explain" | "optimize" | "refactor" | "comments" | "fix" | "modify" | "alternative";

export interface ActionSpec {
  id: ScriptAction;
  label: string;
  /** "chat": answered as a normal documentation-backed answer (no new script). "generate": produces a complete script. */
  mode: "chat" | "generate";
  /** Needs text from the user first. */
  needsInstruction: boolean;
}

export const SCRIPT_ACTIONS: readonly ActionSpec[] = [
  { id: "explain", label: "Explain Code", mode: "chat", needsInstruction: false },
  { id: "optimize", label: "Optimize", mode: "generate", needsInstruction: false },
  { id: "refactor", label: "Refactor", mode: "generate", needsInstruction: false },
  { id: "comments", label: "Add Comments", mode: "generate", needsInstruction: false },
  { id: "fix", label: "Fix Errors", mode: "generate", needsInstruction: false },
  { id: "modify", label: "Modify Script", mode: "generate", needsInstruction: true },
  { id: "alternative", label: "Generate Alternative", mode: "generate", needsInstruction: false },
];

const fence = (code: string): string => `\`\`\`lua\n${code}\n\`\`\``;

/** The findings the script check reported, as plain lines for "Fix Errors". */
export function describeProblems(check: ScriptCheck | undefined): string[] {
  if (!check) return [];
  return check.findings
    .filter((f) => f.severity !== "info")
    .map((f) => `- ${f.severity.toUpperCase()}${f.line ? ` (line ${f.line})` : ""}: ${f.message}`);
}

export interface ActionInput {
  code: string;
  check?: ScriptCheck;
  /** For "Modify Script": what to change. */
  instruction?: string;
  /** For "Generate Alternative": what the script was asked to do. */
  originalRequest?: string;
}

/** The message sent for an action. Written so the generator treats it as a modification of the pasted script (except "alternative"). */
export function buildActionPrompt(action: ScriptAction, input: ActionInput): string {
  const { code } = input;
  switch (action) {
    case "explain":
      return `Explain this script step by step: what it does, how each part works, and which documented GTPS APIs it uses (cite the documentation). Do not change it.\n\n${fence(code)}`;
    case "optimize":
      return `Optimize this script: remove repeated work and unnecessary complexity without changing what it does. Use only documented GTPS APIs. Keep all unrelated functionality exactly as it is, and show the complete updated script.\n\n${fence(code)}`;
    case "refactor":
      return `Refactor this script for readability: clearer names, smaller functions, no duplicated code. Behavior must stay exactly the same, and every feature must be kept. Use only documented GTPS APIs, and show the complete updated script.\n\n${fence(code)}`;
    case "comments":
      return `Add useful comments to this script: what each part does and why. Do not change any code, only add comments, and show the complete script.\n\n${fence(code)}`;
    case "fix": {
      const problems = describeProblems(input.check);
      const found = problems.length
        ? `The documentation check found these problems:\n${problems.join("\n")}\n\nFix every one of them. If a problem is an API that is not in the documentation, replace it with a documented one or remove it and explain what is missing.`
        : "Look for bugs and for any API, parameter or event name that does not match the documentation, and fix them.";
      return `Fix the errors in this script. ${found} Keep everything that is not a problem exactly as it is, and show the complete fixed script.\n\n${fence(code)}`;
    }
    case "modify": {
      const what = (input.instruction ?? "").trim();
      return `Modify this script: ${what || "(no instruction given)"}\n\nKeep all unrelated functionality exactly as it is, explain what changed, and show the complete updated script.\n\n${fence(code)}`;
    }
    case "alternative": {
      const request = (input.originalRequest ?? "").trim();
      return `Write an alternative implementation of the script you just wrote${request ? ` (the original request was: "${request.slice(0, 300)}")` : ""}. It must do the same job but use a different structure or approach. Use only documented GTPS APIs and give the complete script.`;
    }
  }
}

/** `daily_reward.lua` from the "## Script name" section of a reply, or a fallback. */
export function scriptFileName(markdown: string, fallback = "script.lua"): string {
  const section = /^##\s+Script name\s*\n+([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(markdown)?.[1] ?? "";
  const named = /`([^`\n]{1,80}\.lua)`/i.exec(section)?.[1] ?? /([A-Za-z0-9_-]{1,60}\.lua)/i.exec(section)?.[1];
  return named ?? fallback;
}
