"use client";

import { AlertTriangle } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { formatTime } from "@/features/docs/sync-stats";
import type { UseSync } from "@/hooks/use-sync";

const PRESETS: ReadonlyArray<{ minutes: number; label: string }> = [
  { minutes: 15, label: "Every 15 minutes" },
  { minutes: 30, label: "Every 30 minutes" },
  { minutes: 60, label: "Every hour" },
  { minutes: 360, label: "Every 6 hours" },
  { minutes: 720, label: "Every 12 hours" },
  { minutes: 1440, label: "Every day" },
  { minutes: 10080, label: "Every week" },
];

export function ScheduleCard({ sync }: { sync: UseSync }) {
  const { status, unreachable, busy } = sync;
  if (!status) return null;
  const s = status.scheduler;

  const options = PRESETS.some((p) => p.minutes === s.intervalMinutes)
    ? PRESETS
    : [...PRESETS, { minutes: s.intervalMinutes, label: `Every ${s.intervalMinutes} minutes` }].sort(
        (a, b) => a.minutes - b.minutes,
      );

  let nextText = "Not scheduled";
  if (s.enabled && s.schedulePaused) nextText = "Schedule paused";
  else if (s.enabled && status.state !== "idle") nextText = "A sync is running now";
  else if (s.enabled && s.nextRunAt) nextText = formatTime(s.nextRunAt);

  return (
    <div className="mt-4 rounded-md border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Switch
            id="auto-sync"
            checked={s.enabled}
            disabled={busy || unreachable}
            onCheckedChange={(checked) => void sync.updateSettings({ autoEnabled: checked })}
            aria-labelledby="auto-sync-label"
          />
          <label id="auto-sync-label" htmlFor="auto-sync" className="text-sm font-medium">
            Automatic sync
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="sync-interval">Sync interval</label>
          <select
            id="sync-interval"
            value={s.intervalMinutes}
            disabled={busy || unreachable}
            onChange={(e) => void sync.updateSettings({ intervalMinutes: Number(e.target.value) })}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          >
            {options.map((o) => (
              <option key={o.minutes} value={o.minutes} className="bg-popover">
                {o.label}
              </option>
            ))}
          </select>
          {s.enabled && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || unreachable}
              onClick={() => void sync.updateSettings({ schedulePaused: !s.schedulePaused })}
            >
              {s.schedulePaused ? "Resume schedule" : "Pause schedule"}
            </Button>
          )}
        </div>
      </div>

      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Next scheduled sync</dt>
          <dd className="font-medium">{nextText}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Scheduler</dt>
          <dd className={s.healthy ? "font-medium" : "font-medium text-red-500"}>
            {unreachable ? "Backend unreachable" : s.healthy ? "Running in the local backend" : "Not running"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Last scheduled run</dt>
          <dd className="font-medium">{formatTime(s.lastScheduledRunAt)}</dd>
        </div>
      </dl>

      {s.downtimeNotice && (
        <p role="status" className="mt-2 flex gap-2 text-xs text-amber-500">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {s.downtimeNotice}
        </p>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Scheduled synchronization runs inside the local backend process (the Next.js server), not in
        this browser tab, so closing the tab does not stop it. It only runs while that process is
        running: if the server is stopped, nothing is synchronized, and a run that came due in the
        meantime starts when the server is started again.
      </p>
    </div>
  );
}
