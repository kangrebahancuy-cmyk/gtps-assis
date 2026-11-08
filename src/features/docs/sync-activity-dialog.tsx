"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatTime } from "@/features/docs/sync-stats";
import { cn } from "@/lib/utils";
import { syncClient } from "@/services/sync-client";
import type { ScraperLogEntry } from "@/types/scraper";
import type { SyncRunRecord } from "@/types/sync";

const LEVEL_STYLE: Record<ScraperLogEntry["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-amber-500",
  error: "text-red-500",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SyncActivityDialog({ open, onOpenChange }: Props) {
  const [logs, setLogs] = useState<ScraperLogEntry[]>([]);
  const [runs, setRuns] = useState<SyncRunRecord[]>([]);
  const [runId, setRunId] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRuns, nextLogs] = await Promise.all([
        syncClient.getRuns(),
        syncClient.getLogs(300, runId || undefined),
      ]);
      setRuns(nextRuns);
      setLogs(nextLogs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the activity log.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <DialogPrimitive.Content
          aria-describedby="sync-activity-description"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <DialogPrimitive.Title className="text-sm font-semibold">Synchronization activity</DialogPrimitive.Title>
              <DialogPrimitive.Description id="sync-activity-description" className="text-xs text-muted-foreground">
                Most recent entries first.
              </DialogPrimitive.Description>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={() => void load()} aria-label="Refresh" disabled={loading}>
                <RefreshCw className={cn(loading && "animate-spin")} />
              </Button>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close"><X /></Button>
              </DialogPrimitive.Close>
            </div>
          </div>

          <div className="border-b border-border px-4 py-2">
            <label htmlFor="run-filter" className="mr-2 text-xs text-muted-foreground">Show</label>
            <select
              id="run-filter"
              value={runId}
              onChange={(e) => setRunId(e.target.value)}
              className="h-8 max-w-full rounded-md border border-input bg-transparent px-2 text-xs"
            >
              <option value="" className="bg-popover">All activity</option>
              {runs.map((run) => (
                <option key={run.id} value={run.id} className="bg-popover">
                  {formatTime(run.startedAt)} · {run.mode} · {run.trigger} · {run.status.replace(/_/g, " ")} ·
                  {" "}+{run.counts.added} ~{run.counts.updated} ={run.counts.unchanged} -{run.counts.deleted} !{run.counts.failed}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              + new, ~ updated, = unchanged, - deleted, ! failed
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
            {error ? (
              <p role="alert" className="text-sm text-red-500">{error}</p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{loading ? "Loading…" : "No activity yet."}</p>
            ) : (
              <ul className="space-y-1.5 font-mono text-xs">
                {logs.map((entry) => (
                  <li key={entry.id} className="break-words">
                    <span className="text-muted-foreground">{entry.createdAt.slice(5, 19).replace("T", " ")} </span>
                    <span className={cn("font-semibold uppercase", LEVEL_STYLE[entry.level])}>{entry.level} </span>
                    {entry.message}
                    {entry.url && <span className="text-muted-foreground"> — {entry.url}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
