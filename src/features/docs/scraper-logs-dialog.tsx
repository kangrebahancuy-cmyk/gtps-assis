"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { scraperClient } from "@/services/scraper-client";
import type { ScraperLogEntry } from "@/types/scraper";
import { cn } from "@/lib/utils";

const LEVEL_STYLE: Record<ScraperLogEntry["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-amber-500",
  error: "text-red-500",
};

interface ScraperLogsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ScraperLogsDialog({ open, onOpenChange }: ScraperLogsDialogProps) {
  const [logs, setLogs] = useState<ScraperLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLogs(await scraperClient.getLogs(300));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load logs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <DialogPrimitive.Content
          aria-describedby="scraper-logs-description"
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[80dvh] w-[calc(100vw-2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <DialogPrimitive.Title className="text-sm font-semibold">
                Scraping logs
              </DialogPrimitive.Title>
              <DialogPrimitive.Description
                id="scraper-logs-description"
                className="text-xs text-muted-foreground"
              >
                Most recent entries first.
              </DialogPrimitive.Description>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" onClick={() => void load()} aria-label="Refresh logs" disabled={loading}>
                <RefreshCw className={cn(loading && "animate-spin")} />
              </Button>
              <DialogPrimitive.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close">
                  <X />
                </Button>
              </DialogPrimitive.Close>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
            {error ? (
              <p role="alert" className="text-sm text-red-500">{error}</p>
            ) : logs.length === 0 ? (
              <p className="text-sm text-muted-foreground">{loading ? "Loading…" : "No log entries yet."}</p>
            ) : (
              <ul className="space-y-1.5 font-mono text-xs">
                {logs.map((entry) => (
                  <li key={entry.id} className="break-words">
                    <span className="text-muted-foreground">{entry.createdAt.slice(11, 19)} </span>
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
