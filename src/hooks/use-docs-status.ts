"use client";

import { useEffect, useState } from "react";

import { docsClient } from "@/services/docs-client";
import { BackendUnreachableError } from "@/services/sync-client";
import type { DocsStatus } from "@/types/docs";

const ACTIVE_POLL_MS = 1500;
const IDLE_POLL_MS = 6000;

export interface UseDocsStatus {
  status: DocsStatus | null;
  error: string | null;
  unreachable: boolean;
}

/** Polls the real index/sync status; faster while a synchronization is running. */
export function useDocsStatus(): UseDocsStatus {
  const [status, setStatus] = useState<DocsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      let delay = IDLE_POLL_MS;
      try {
        const next = await docsClient.status();
        if (stopped) return;
        setStatus(next);
        setError(null);
        setUnreachable(false);
        if (next.sync.state !== "idle") delay = ACTIVE_POLL_MS;
      } catch (e) {
        if (stopped) return;
        if (e instanceof BackendUnreachableError) setUnreachable(true);
        else setError(e instanceof Error ? e.message : "Could not load status.");
      }
      if (!stopped) timer = setTimeout(() => void poll(), delay);
    }

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return { status, error, unreachable };
}
