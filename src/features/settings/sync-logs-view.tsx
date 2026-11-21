"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { formatTime } from "@/features/docs/sync-stats";
import { syncClient } from "@/services/sync-client";
import type { LogLevel, ScraperLogEntry } from "@/types/scraper";
import type { SyncRunRecord } from "@/types/sync";

const LEVEL_STYLE: Record<LogLevel, string> = { info: "text-muted-foreground", warn: "text-amber-600 dark:text-amber-400", error: "text-red-600 dark:text-red-400" };

/** The scraper's own log, read from the local database. Newest first; filter by run and level. */
export function SyncLogsView({ refreshKey }: { refreshKey: string }) {
  const [logs, setLogs] = useState<ScraperLogEntry[]>([]);
  const [runs, setRuns] = useState<SyncRunRecord[]>([]);
  const [runId, setRunId] = useState("");
  const [level, setLevel] = useState<"all" | LogLevel>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextRuns, nextLogs] = await Promise.all([syncClient.getRuns(), syncClient.getLogs(300, runId || undefined)]);
      setRuns(nextRuns);
      setLogs(nextLogs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the logs.");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  // Reload when the filter changes and whenever a run starts or finishes (refreshKey changes).
  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const shown = level === "all" ? logs : logs.filter((l) => l.level === level);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="log-run">Run</label>
        <select id="log-run" value={runId} onChange={(e) => setRunId(e.target.value)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
          <option value="" className="bg-popover">All runs</option>
          {runs.map((r) => (
            <option key={r.id} value={r.id} className="bg-popover">{`${r.mode} · ${r.status.replace(/_/g, " ")} · ${formatTime(r.startedAt)}`}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="log-level">Level</label>
        <select id="log-level" value={level} onChange={(e) => setLevel(e.target.value as "all" | LogLevel)} className="h-8 rounded-md border border-input bg-transparent px-2 text-xs">
          <option value="all" className="bg-popover">All levels</option>
          <option value="info" className="bg-popover">Info</option>
          <option value="warn" className="bg-popover">Warnings</option>
          <option value="error" className="bg-popover">Errors</option>
        </select>
        <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw /> Refresh
        </Button>
        <span className="text-xs text-muted-foreground" data-testid="log-count">{shown.length} entr{shown.length === 1 ? "y" : "ies"}</span>
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {shown.length === 0 && !error ? (
        <p className="text-sm text-muted-foreground" data-testid="log-empty">{logs.length === 0 ? "No log entries yet. They appear after the first synchronization." : "No entries match this filter."}</p>
      ) : (
        <ul className="max-h-80 space-y-1 overflow-y-auto font-mono text-xs scrollbar-thin" aria-label="Scraper log">
          {shown.map((l) => (
            <li key={l.id} data-testid="log-row" data-level={l.level} className="break-words">
              <span className="text-muted-foreground">{formatTime(l.createdAt)} </span>
              <span className={LEVEL_STYLE[l.level]}>[{l.level}] </span>
              {l.message}
              {l.url ? <span className="text-muted-foreground"> — {l.url}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
