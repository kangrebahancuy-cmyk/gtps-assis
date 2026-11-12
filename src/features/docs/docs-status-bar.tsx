"use client";

import { AlertTriangle, RefreshCw, WifiOff } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { UseDocsStatus } from "@/hooks/use-docs-status";

function Tile({ label, value, hint, warn }: { label: string; value: string | number; hint?: string; warn?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-3 py-1.5">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={`truncate text-base font-semibold tabular-nums ${warn ? "text-red-500" : ""}`}>{value}</dd>
      {hint && <p className="truncate text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

interface DocsStatusBarProps {
  data: UseDocsStatus;
  syncOpen: boolean;
  onToggleSync: () => void;
}

/** Index and synchronization status. Every figure is read from the database or the live sync engine. */
export function DocsStatusBar({ data, syncOpen, onToggleSync }: DocsStatusBarProps) {
  const { status, error, unreachable } = data;

  return (
    <section aria-label="Documentation status" className="border-b border-border bg-card/40 px-4 py-2.5">
      {unreachable && (
        <p role="alert" className="mb-2 flex items-start gap-2 text-sm text-red-500">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Cannot reach the local backend. The figures below are from the last successful update.
        </p>
      )}
      {error && <p role="alert" className="mb-2 text-sm text-red-500">{error}</p>}

      {status ? (
        <>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Tile label="Indexed documents" value={status.totals.documents} hint={`${status.totals.categories} categories`} />
            <Tile
              label="API entries"
              value={status.totals.apiEntries}
              hint={`${status.apiByKind.function + status.apiByKind.method} fn · ${status.apiByKind.callback} cb · ${status.apiByKind.event} ev`}
            />
            <Tile label="Lua examples" value={status.totals.luaExamples} hint={`${status.totals.codeExamples} code blocks`} />
            <Tile label="Last successful sync" value={formatDateTime(status.lastSuccessAt)} />
            <Tile
              label="Failed pages"
              value={status.failedPages.length}
              warn={status.failedPages.length > 0}
              hint={status.removedDocuments > 0 ? `${status.removedDocuments} removed at source` : undefined}
            />
            <div className="min-w-0 rounded-md border border-border px-3 py-1.5">
              <dt className="text-[11px] text-muted-foreground">Synchronization</dt>
              <dd className="flex items-center gap-2 text-base font-semibold">
                <Badge variant={status.sync.state === "idle" ? "muted" : "default"}>{status.sync.state}</Badge>
                {status.sync.current && (
                  <span className="text-xs font-normal tabular-nums text-muted-foreground">
                    {status.sync.current.progress.processed}/{status.sync.current.progress.total}
                  </span>
                )}
              </dd>
              {status.sync.state === "idle" && status.lastRun && (
                <p className="truncate text-[11px] text-muted-foreground">
                  last run: {status.lastRun.status.replace(/_/g, " ")}
                </p>
              )}
            </div>
          </dl>

          {status.totals.searchIndexed !== status.totals.documents && (
            <p role="alert" className="mt-2 flex items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              Search index is incomplete: {status.totals.searchIndexed} of {status.totals.documents} documents are searchable.
            </p>
          )}

          {status.failedPages.length > 0 && (
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {status.failedPages.length} page{status.failedPages.length === 1 ? "" : "s"} failed to synchronize (indexed copies are kept)
              </summary>
              <ul className="mt-1.5 space-y-1 text-xs">
                {status.failedPages.map((page) => (
                  <li key={page.url} className="break-words">
                    <span className="font-mono">{page.url}</span>
                    <span className="text-red-500"> — {page.error ?? "Unknown error"}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        !unreachable && !error && <p className="text-sm text-muted-foreground">Loading status…</p>
      )}

      <div className="mt-2">
        <Button variant="outline" size="sm" onClick={onToggleSync} aria-expanded={syncOpen}>
          <RefreshCw />
          {syncOpen ? "Hide synchronization controls" : "Synchronization controls"}
        </Button>
      </div>
    </section>
  );
}
