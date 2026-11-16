"use client";

import { Check, Code2, Copy, Download } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { downloadText } from "@/lib/download";
import { SCRIPT_ACTIONS, type ScriptAction } from "@/lib/lua/actions";

export interface ScriptActionsProps {
  /** The Lua code of the reply (only the script, not the explanation around it). */
  code: string;
  /** File name for Download, e.g. "daily_reward.lua". */
  fileName: string;
  /** Actions that send a new request are unavailable while a reply is being written. */
  busy: boolean;
  /** Set when the reply is still streaming: the code is not complete yet. */
  incomplete?: boolean;
  onOpenInWorkspace: () => void;
  onAction: (action: ScriptAction, instruction?: string) => void;
}

/**
 * What can be done with a generated script: Copy, Download .lua and Open in Lua Workspace work on the code
 * itself; the rest send a request that goes through the generator again (documentation retrieved, result checked).
 */
export function ScriptActions({ code, fileName, busy, incomplete = false, onOpenInWorkspace, onAction }: ScriptActionsProps) {
  const [copied, setCopied] = useState<"idle" | "ok" | "failed">("idle");
  const [asking, setAsking] = useState(false);
  const [instruction, setInstruction] = useState("");

  useEffect(() => {
    if (copied === "idle") return;
    const timer = window.setTimeout(() => setCopied("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const direct = incomplete || code.trim() === "";
  return (
    <section aria-label="Script actions" data-testid="script-actions" className="mt-3 rounded-md border border-border bg-secondary/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="outline" size="sm" disabled={direct} onClick={async () => setCopied((await copyText(code)) ? "ok" : "failed")} aria-label="Copy script">
          {copied === "ok" ? <Check /> : <Copy />}
          {copied === "ok" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy"}
        </Button>
        <Button variant="outline" size="sm" disabled={direct} onClick={() => downloadText(fileName, `${code}\n`, "text/x-lua")} aria-label={`Download ${fileName}`} title={`Download ${fileName}`}>
          <Download />
          Download .lua
        </Button>
        <Button variant="outline" size="sm" disabled={direct} onClick={onOpenInWorkspace} aria-label="Open in Lua Workspace">
          <Code2 />
          Open in Lua Workspace
        </Button>
        <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
        {SCRIPT_ACTIONS.map((action) => (
          <Button
            key={action.id}
            variant="ghost"
            size="sm"
            disabled={direct || busy}
            title={busy ? "Wait for the current reply to finish" : action.mode === "chat" ? "Answered from the documentation; the script is not changed" : "Writes a new version and checks it against the documentation"}
            aria-pressed={action.id === "modify" ? asking : undefined}
            onClick={() => (action.needsInstruction ? setAsking((v) => !v) : onAction(action.id))}
          >
            {action.label}
          </Button>
        ))}
      </div>
      {asking ? (
        <form
          className="mt-2 flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            const text = instruction.trim();
            if (text === "" || busy) return;
            setAsking(false);
            setInstruction("");
            onAction("modify", text);
          }}
        >
          <label className="sr-only" htmlFor="modify-instruction">
            What should change in this script?
          </label>
          <input
            id="modify-instruction"
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            maxLength={2000}
            placeholder="What should change? e.g. add a 10 minute cooldown"
            className="min-w-0 flex-1 rounded-md border border-input bg-background px-3 py-1.5 text-sm"
          />
          <Button type="submit" size="sm" disabled={instruction.trim() === "" || busy}>
            Modify
          </Button>
        </form>
      ) : null}
    </section>
  );
}
