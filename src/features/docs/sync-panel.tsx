"use client";

import { WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { ScheduleCard } from "@/features/docs/schedule-card";
import { SyncActivityDialog } from "@/features/docs/sync-activity-dialog";
import { SyncControls } from "@/features/docs/sync-controls";
import { SyncProgress, SyncStats } from "@/features/docs/sync-stats";
import { useSync } from "@/hooks/use-sync";

interface SyncPanelProps {
  /** Called whenever the indexed documents may have changed. */
  onDocumentsChanged?: () => void;
}

export function SyncPanel({ onDocumentsChanged }: SyncPanelProps) {
  const sync = useSync();
  const { status, error, unreachable } = sync;
  const [activityOpen, setActivityOpen] = useState(false);

  // Reload the document list when a run finishes or while one is changing the index.
  const signature = status
    ? `${status.totals.documents}|${status.totals.deleted}|${status.lastRun?.id ?? ""}|${status.lastRun?.finishedAt ?? ""}`
    : "";
  const previous = useRef("");
  useEffect(() => {
    if (signature && signature !== previous.current) {
      if (previous.current !== "") onDocumentsChanged?.();
      previous.current = signature;
    }
  }, [signature, onDocumentsChanged]);

  const state = status?.state ?? "idle";

  return (
    <section aria-labelledby="sync-heading" className="max-h-[60dvh] overflow-y-auto border-b border-border bg-card/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="sync-heading" className="text-sm font-semibold">Documentation sync</h2>
          {status && <Badge variant={state === "idle" ? "muted" : "default"}>{state}</Badge>}
        </div>
        <SyncControls sync={sync} onOpenActivity={() => setActivityOpen(true)} />
      </div>

      {unreachable && (
        <p role="alert" className="mt-2 flex items-start gap-2 rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-500">
          <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Cannot reach the local backend. Scheduled synchronization is not running while the backend is
          unreachable. The figures below are from the last successful update.
        </p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-red-500">{error}</p>}

      {status ? (
        <>
          <SyncStats status={status} />
          <SyncProgress status={status} />

          {status.lastRun?.error && state === "idle" && (
            <p role="alert" className="mt-2 text-sm text-red-500">
              Last run {status.lastRun.status.replace(/_/g, " ")}: {status.lastRun.error}
            </p>
          )}

          {status.failedPages.length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {status.failedPages.length} failed document{status.failedPages.length === 1 ? "" : "s"} (indexed copies are kept)
              </summary>
              <ul className="mt-2 space-y-1 text-xs">
                {status.failedPages.map((page) => (
                  <li key={page.url} className="break-words">
                    <span className="font-mono">{page.url}</span>
                    <span className="text-red-500"> — {page.error ?? "Unknown error"}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <ScheduleCard sync={sync} />
        </>
      ) : (
        !unreachable && <p className="mt-3 text-sm text-muted-foreground">Loading status…</p>
      )}

      <SyncActivityDialog open={activityOpen} onOpenChange={setActivityOpen} />
    </section>
  );
}
