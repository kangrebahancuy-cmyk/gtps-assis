"use client";

import { Loader2, Play, RotateCcw, ScrollText, Square } from "lucide-react";
import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScraperLogsDialog } from "@/features/docs/scraper-logs-dialog";
import { useScraper } from "@/hooks/use-scraper";

function formatTime(iso: string | null): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toLocaleString();
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

export function ScraperPanel({ onDataChanged }: { onDataChanged?: () => void }) {
  const { status, error, busy, start, cancel } = useScraper();
  const [logsOpen, setLogsOpen] = useState(false);

  const running = status?.status === "running" || status?.status === "cancelling";
  const stats = status?.stats;
  const progress = status?.progress;

  async function handleStart(mode: "full" | "retry") {
    await start(mode);
    onDataChanged?.();
  }

  return (
    <section aria-labelledby="scraper-heading" className="border-b border-border bg-card/40 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 id="scraper-heading" className="text-sm font-semibold">Documentation sync</h2>
          {status && (
            <Badge variant={running ? "default" : "muted"}>
              {status.status === "idle" ? "Idle" : status.status}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {running ? (
            <Button size="sm" variant="outline" onClick={() => void cancel()} disabled={busy || status?.status === "cancelling"}>
              <Square /> {status?.status === "cancelling" ? "Cancelling…" : "Cancel"}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void handleStart("full")} disabled={busy || !status}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />} Start Scraping
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handleStart("retry")}
            disabled={busy || running || !stats || stats.failed === 0}
          >
            <RotateCcw /> Retry failed{stats && stats.failed > 0 ? ` (${stats.failed})` : ""}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setLogsOpen(true)}>
            <ScrollText /> View logs
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-500">{error}</p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Discovered pages" value={stats?.discovered ?? "-"} />
        <Stat label="Scraped" value={stats?.scraped ?? "-"} />
        <Stat label="Failed" value={stats?.failed ?? "-"} />
        <Stat label="Last scraped" value={status ? formatTime(status.lastScrapedAt) : "-"} />
      </dl>

      {(running || (progress && progress.total > 0)) && progress && (
        <div className="mt-3">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span className="truncate">{running && progress.currentUrl ? progress.currentUrl : "Last run"}</span>
            <span className="tabular-nums">{progress.processed}/{progress.total} ({progress.percent}%)</span>
          </div>
          <div
            role="progressbar"
            aria-label="Scraping progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            className="h-1.5 overflow-hidden rounded-full bg-secondary"
          >
            <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {status?.lastError && (
        <p role="alert" className="mt-2 text-sm text-red-500">Last error: {status.lastError}</p>
      )}

      {status && status.failedPages.length > 0 && (
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {status.failedPages.length} failed page{status.failedPages.length === 1 ? "" : "s"}
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

      <ScraperLogsDialog open={logsOpen} onOpenChange={setLogsOpen} />
    </section>
  );
}
