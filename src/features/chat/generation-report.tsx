"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { StoredMessage } from "@/lib/chat/types";
import { RUNTIME_SCOPE } from "@/lib/workspace/validation";
import type { ApiUse, Finding, ScriptCheck } from "@/types/lua";

const SEVERITY_ICON = { error: CircleAlert, warning: TriangleAlert, info: Info } as const;
const SEVERITY_CLASS = { error: "text-destructive", warning: "text-amber-600 dark:text-amber-400", info: "text-muted-foreground" } as const;

const STATUS_LABEL: Record<ApiUse["status"], string> = {
  documented: "documented",
  undocumented: "not in documentation",
  lua_standard: "standard Lua",
  unresolved: "unverified",
};

function FindingRow({ finding }: { finding: Finding }) {
  const Icon = SEVERITY_ICON[finding.severity];
  return (
    <li data-testid="finding" data-severity={finding.severity} className="flex items-start gap-1.5">
      <Icon className={`mt-0.5 size-3.5 shrink-0 ${SEVERITY_CLASS[finding.severity]}`} aria-hidden="true" />
      <span className="min-w-0 break-words">
        {finding.line ? <span className="font-mono text-muted-foreground">line {finding.line}: </span> : null}
        {finding.message}
      </span>
    </li>
  );
}

export function countUses(check: ScriptCheck): Record<ApiUse["status"], number> {
  const counts: Record<ApiUse["status"], number> = { documented: 0, undocumented: 0, lua_standard: 0, unresolved: 0 };
  for (const use of check.apiUses) counts[use.status] += 1;
  return counts;
}

export function CheckSection({ check }: { check: ScriptCheck }) {
  const counts = countUses(check);
  const errors = check.findings.filter((f) => f.severity === "error").length;
  const warnings = check.findings.filter((f) => f.severity === "warning").length;
  const p = check.preservation;
  return (
    <div data-testid="script-check" data-passed={check.passed} className="mt-2 space-y-1.5">
      <p className="flex flex-wrap items-center gap-2">
        {check.passed ? <CircleCheck className="size-3.5 text-green-600" aria-hidden="true" /> : <CircleAlert className="size-3.5 text-destructive" aria-hidden="true" />}
        <strong className="font-medium">{check.passed ? "Script check: no problems found" : "Script check found problems"}</strong>
        <span className="text-muted-foreground" data-testid="check-summary">
          {check.stats.lines} lines · {check.stats.functions} function{check.stats.functions === 1 ? "" : "s"} · {check.stats.calls} call{check.stats.calls === 1 ? "" : "s"} · {errors} error{errors === 1 ? "" : "s"} · {warnings} warning{warnings === 1 ? "" : "s"}
        </span>
      </p>
      <p data-testid="syntax-status" className={check.syntax.ok ? "text-muted-foreground" : "text-destructive"}>
        Syntax: {check.syntax.ok ? "no syntax errors found" : `error at line ${check.syntax.line}, column ${check.syntax.column}: ${check.syntax.message}`}
      </p>
      <p data-testid="runtime-note" className="text-muted-foreground">
        {RUNTIME_SCOPE}
      </p>
      {check.apiUses.length > 0 ? (
        <>
          <p className="text-muted-foreground" data-testid="api-summary">
            APIs used: {counts.documented} documented · {counts.undocumented} not in the documentation · {counts.lua_standard} standard Lua{counts.unresolved ? ` · ${counts.unresolved} unverified` : ""}
          </p>
          <ul className="space-y-0.5" aria-label="APIs used by the script">
            {check.apiUses.map((u) => (
              <li key={`${u.status}|${u.name}`} data-testid="api-use" data-status={u.status} className="flex flex-wrap items-center gap-x-2">
                <code className="font-mono">{u.name}</code>
                <Badge variant={u.status === "documented" ? "default" : "muted"}>{STATUS_LABEL[u.status]}</Badge>
                {u.source ? (
                  <a href={u.source.url} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-2">
                    {u.source.title}
                  </a>
                ) : null}
                {u.suggestion ? <span className="text-muted-foreground">did you mean {u.suggestion}?</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {check.findings.length > 0 ? (
        <ul className="space-y-1" aria-label="Findings">
          {check.findings.map((f, i) => (
            <FindingRow key={i} finding={f} />
          ))}
        </ul>
      ) : null}
      {p ? (
        <div data-testid="preservation" className="text-muted-foreground">
          <p>
            Compared with the original: {p.preserved.length} unchanged · {p.modified.length} changed · {p.removed.length} removed · {p.added.length} added
          </p>
          {p.removed.length > 0 ? <p className="text-amber-700 dark:text-amber-300">Removed: {p.removed.join("; ")}</p> : null}
          {p.modified.length > 0 ? <p>Changed: {p.modified.join("; ")}</p> : null}
          {p.added.length > 0 ? <p>Added: {p.added.join("; ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The record of how a script was produced: what the request was analysed as, which documentation topics were
 * searched and how many sections each one found, and what the check of the finished script found.
 * Every number is the backend's, nothing is estimated here.
 */
export function GenerationReport({ message }: { message: StoredMessage }) {
  const generation = message.meta.docs?.generation;
  const check = message.meta.check;
  if (!generation && !check) return null;
  return (
    <section aria-label="Generation report" data-testid="generation-report" className="mt-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
      <details open={message.status !== "streaming"}>
        <summary className="cursor-pointer font-medium">Generation report</summary>
        {generation ? (
          <div data-testid="analysis" className="mt-2 space-y-1">
            <p>
              <span className="text-muted-foreground">Request: </span>
              {generation.modifying ? "modification of an existing script" : "new script"}
              {generation.featureLabels.length ? ` · ${generation.featureLabels.join(", ")}` : " · no standard script type recognised"}
            </p>
            <p className="text-muted-foreground">Documentation topics searched ({generation.topics.length}):</p>
            <ul className="space-y-0.5" aria-label="Documentation topics">
              {generation.topics.map((t) => (
                <li key={t.label} data-testid="topic" data-found={t.found} className="flex items-baseline gap-2">
                  <span className="font-mono text-muted-foreground">{t.found}</span>
                  <span>{t.label}</span>
                </li>
              ))}
            </ul>
            {generation.missingTopics.length > 0 ? (
              <p role="note" data-testid="missing-topics" className="text-amber-700 dark:text-amber-300">
                No documentation found for: {generation.missingTopics.join("; ")}. The script should not rely on APIs for these.
              </p>
            ) : null}
            <p className="text-muted-foreground" data-testid="required-apis">
              {generation.requiredApis.length} documented API entr{generation.requiredApis.length === 1 ? "y" : "ies"} on the retrieved pages{generation.requiredApis.length ? `: ${generation.requiredApis.slice(0, 12).join(", ")}${generation.requiredApis.length > 12 ? ", …" : ""}` : ""}
            </p>
          </div>
        ) : null}
        {check ? <CheckSection check={check} /> : message.status === "complete" && generation ? <p className="mt-2 text-muted-foreground">No script was found in this reply, so nothing was checked.</p> : null}
      </details>
    </section>
  );
}
