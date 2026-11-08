"use client";

import { Loader2, Pause, Play, RefreshCw, RotateCcw, ScrollText, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { UseSync } from "@/hooks/use-sync";

interface SyncControlsProps {
  sync: UseSync;
  onOpenActivity: () => void;
}

export function SyncControls({ sync, onOpenActivity }: SyncControlsProps) {
  const { status, busy } = sync;
  const state = status?.state ?? "idle";
  const idle = state === "idle";
  const failed = status?.totals.failedOutstanding ?? 0;
  const disabled = busy || !status;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {idle ? (
        <>
          <Button
            size="sm"
            onClick={() => void sync.startSync("auto")}
            disabled={disabled}
            title="Full sync the first time, incremental afterwards"
          >
            {busy ? <Loader2 className="animate-spin" /> : <Play />} Sync now
          </Button>
          <Button size="sm" variant="outline" onClick={() => void sync.startSync("incremental")} disabled={disabled}
            title="Only reprocess pages that changed">
            <RefreshCw /> Incremental
          </Button>
          <Button size="sm" variant="outline" onClick={() => void sync.startSync("full")} disabled={disabled}
            title="Re-fetch every known page">
            <RefreshCw /> Full sync
          </Button>
          <Button size="sm" variant="outline" onClick={() => void sync.startSync("retry")} disabled={disabled || failed === 0}>
            <RotateCcw /> Retry failed{failed > 0 ? ` (${failed})` : ""}
          </Button>
        </>
      ) : (
        <>
          {state === "paused" ? (
            <Button size="sm" onClick={() => void sync.resume()} disabled={busy}>
              <Play /> Resume
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => void sync.pause()} disabled={busy || state !== "running"}>
              <Pause /> Pause
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={() => void sync.cancel()} disabled={busy || state === "cancelling"}>
            <Square /> {state === "cancelling" ? "Cancelling…" : "Cancel"}
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" onClick={onOpenActivity}>
        <ScrollText /> Activity log
      </Button>
    </div>
  );
}
