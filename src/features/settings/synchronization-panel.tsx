"use client";

import { WifiOff } from "lucide-react";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScheduleCard } from "@/features/docs/schedule-card";
import { SyncControls } from "@/features/docs/sync-controls";
import { SyncProgress, SyncStats } from "@/features/docs/sync-stats";
import { SyncLogsView } from "@/features/settings/sync-logs-view";
import { useSync } from "@/hooks/use-sync";
import { MAX_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES } from "@/types/sync";

/** Synchronization controls, schedule, failed documents and the scraper log, all from the real backend. */
export function SynchronizationPanel() {
  const sync = useSync();
  const { status, error, unreachable } = sync;
  const [custom, setCustom] = useState("");
  const [customError, setCustomError] = useState<string | null>(null);
  const logsRef = useRef<HTMLParagraphElement>(null);

  const state = status?.state ?? "idle";
  const logKey = status ? `${state}|${status.lastRun?.id ?? ""}|${status.lastRun?.finishedAt ?? ""}` : "";

  function applyCustom() {
    const minutes = Number(custom);
    if (!Number.isInteger(minutes) || minutes < MIN_INTERVAL_MINUTES || minutes > MAX_INTERVAL_MINUTES) {
      setCustomError(`Enter a whole number of minutes from ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES}.`);
      return;
    }
    setCustomError(null);
    setCustom("");
    void sync.updateSettings({ intervalMinutes: minutes });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <p className="text-sm font-medium">Synchronization</p>
              {status ? <Badge variant={state === "idle" ? "muted" : "default"} data-testid="sync-state">{state}</Badge> : null}
            </div>
            <SyncControls sync={sync} onOpenActivity={() => logsRef.current?.scrollIntoView?.({ block: "start" })} />
          </div>
          {unreachable ? (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-red-500/40 px-3 py-2 text-sm text-red-500">
              <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Cannot reach the local backend. Scheduled synchronization is not running while it is unreachable.
            </p>
          ) : null}
          {error ? <p role="alert" className="text-sm text-red-500">{error}</p> : null}
          {status ? (
            <>
              <SyncStats status={status} />
              <SyncProgress status={status} />
              {status.lastRun?.error && state === "idle" ? (
                <p role="alert" className="text-sm text-red-500">Last run {status.lastRun.status.replace(/_/g, " ")}: {status.lastRun.error}</p>
              ) : null}
            </>
          ) : !unreachable ? (
            <p className="text-sm text-muted-foreground">Loading status…</p>
          ) : null}
        </CardContent>
      </Card>

      {status ? (
        <Card>
          <CardContent className="space-y-3 p-5">
            <p className="text-sm font-medium">Schedule</p>
            <ScheduleCard sync={sync} />
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <label htmlFor="custom-interval" className="text-sm font-medium">Custom interval (minutes)</label>
                <Input id="custom-interval" inputMode="numeric" value={custom} placeholder={`${MIN_INTERVAL_MINUTES}–${MAX_INTERVAL_MINUTES}`} onChange={(e) => setCustom(e.target.value)} className="w-40" />
              </div>
              <Button size="sm" variant="outline" disabled={sync.busy || unreachable || custom.trim() === ""} onClick={applyCustom}>Set interval</Button>
            </div>
            {customError ? <p role="alert" className="text-sm text-destructive">{customError}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      {status && status.failedPages.length > 0 ? (
        <Card>
          <CardContent className="space-y-2 p-5">
            <p className="text-sm font-medium">Failed documents ({status.failedPages.length})</p>
            <p className="text-xs text-muted-foreground">Their previously indexed copies are kept. Use “Retry failed” above to try them again.</p>
            <ul className="space-y-1 text-xs" data-testid="failed-pages">
              {status.failedPages.map((page) => (
                <li key={page.url} className="break-words">
                  <span className="font-mono">{page.url}</span>
                  <span className="text-red-500"> — {page.error ?? "Unknown error"}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="space-y-3 p-5">
          <p ref={logsRef} className="text-sm font-medium">Scraper logs</p>
          <SyncLogsView refreshKey={logKey} />
        </CardContent>
      </Card>
    </div>
  );
}
