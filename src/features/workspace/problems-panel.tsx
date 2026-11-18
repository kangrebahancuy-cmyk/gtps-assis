"use client";

import { CircleAlert, CircleCheck, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CheckSection } from "@/features/chat/generation-report";
import { DOCS_SCOPE, RUNTIME_SCOPE, SYNTAX_SCOPE, SYNTAX_SCOPE_TITLE, type SyntaxReport } from "@/lib/workspace/validation";
import type { ScriptCheck } from "@/types/lua";

export type DocsCheckState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "done"; check: ScriptCheck; stale: boolean }
  | { status: "error"; message: string };

interface ProblemsPanelProps {
  report: SyntaxReport | null;
  docs: DocsCheckState;
  onGoTo(line: number, column: number): void;
  onCheckDocs(): void;
  canCheckDocs: boolean;
}

/**
 * Keeps the three kinds of checking apart: local syntax check (instant), documentation check
 * (server, on request) and GTPS runtime (never done). A clean syntax check never says the script works.
 */
export function ProblemsPanel({ report, docs, onGoTo, onCheckDocs, canCheckDocs }: ProblemsPanelProps) {
  return (
    <section aria-label="Problems" className="max-h-64 overflow-y-auto border-t border-border text-sm">
      <div className="grid gap-4 p-3 lg:grid-cols-3">
        <div data-testid="syntax-panel">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">1 · {SYNTAX_SCOPE_TITLE} (local)</h3>
          {report === null ? (
            <p className="text-muted-foreground">Checking…</p>
          ) : report.clean ? (
            <p data-testid="syntax-clean" className="flex items-center gap-1.5">
              <CircleCheck className="size-4 text-green-600" aria-hidden="true" /> No syntax errors found
            </p>
          ) : (
            <ul>
              {report.problems.map((p, i) => (
                <li key={i}>
                  <button type="button" data-testid="syntax-problem" onClick={() => onGoTo(p.line, p.column)} className="flex w-full items-start gap-1.5 rounded p-1 text-left hover:bg-accent">
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
                    <span>
                      <span className="font-mono text-muted-foreground">
                        {p.line}:{p.column}{" "}
                      </span>
                      {p.message}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-xs text-muted-foreground" data-testid="syntax-scope">
            {SYNTAX_SCOPE}
          </p>
        </div>

        <div data-testid="docs-panel">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">2 · Documentation check (on request)</h3>
          <Button size="sm" variant="outline" onClick={onCheckDocs} disabled={!canCheckDocs || docs.status === "running"}>
            {docs.status === "running" ? <Loader2 className="animate-spin" /> : null}
            Check against documentation
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">{DOCS_SCOPE}</p>
          {docs.status === "error" && (
            <p role="alert" className="mt-1 text-destructive">
              {docs.message}
            </p>
          )}
          {docs.status === "done" && (
            <div className="mt-1" data-testid="docs-result" data-stale={docs.stale}>
              {docs.stale && <p className="text-amber-700 dark:text-amber-300">The code changed after this check. Run it again.</p>}
              <CheckSection check={docs.check} />
            </div>
          )}
        </div>

        <div data-testid="runtime-panel">
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">3 · GTPS runtime</h3>
          <p className="text-muted-foreground" data-testid="runtime-scope">
            {RUNTIME_SCOPE}
          </p>
        </div>
      </div>
    </section>
  );
}
