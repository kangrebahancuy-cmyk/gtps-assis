"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ScraperApiError, scraperClient } from "@/services/scraper-client";
import type { ScraperMode, ScraperStatusResponse } from "@/types/scraper";

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;

interface UseScraper {
  status: ScraperStatusResponse | null;
  error: string | null;
  busy: boolean;
  start: (mode: ScraperMode) => Promise<void>;
  cancel: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Polls scraper status, faster while a run is active. */
export function useScraper(): UseScraper {
  const [status, setStatus] = useState<ScraperStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await scraperClient.getStatus();
      if (!alive.current) return;
      setStatus(next);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    let cancelled = false;

    async function tick() {
      await refresh();
      if (cancelled) return;
      timer.current = window.setTimeout(tick, ACTIVE_POLL_MS);
    }
    void tick();

    return () => {
      cancelled = true;
      alive.current = false;
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [refresh]);

  // Slow the polling down when nothing is running.
  const active = status?.status === "running" || status?.status === "cancelling";
  useEffect(() => {
    if (active || timer.current === null) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void refresh(), IDLE_POLL_MS);
  }, [active, status, refresh]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        setError(null);
      } catch (e) {
        setError(e instanceof ScraperApiError ? e.message : "Unknown error");
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [refresh],
  );

  return {
    status,
    error,
    busy,
    start: (mode) => run(() => scraperClient.start(mode)),
    cancel: () => run(() => scraperClient.cancel()),
    refresh,
  };
}
