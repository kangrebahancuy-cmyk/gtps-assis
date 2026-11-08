"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  BackendUnreachableError,
  syncClient,
} from "@/services/sync-client";
import type { SyncSettings, SyncStatus } from "@/types/sync";

const ACTIVE_POLL_MS = 1000;
const IDLE_POLL_MS = 5000;

export interface UseSync {
  status: SyncStatus | null;
  /** Last action/poll error that is not "backend unreachable". */
  error: string | null;
  /** True while the last poll could not reach the backend at all. */
  unreachable: boolean;
  busy: boolean;
  startSync: (mode: "auto" | "full" | "incremental" | "retry") => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  cancel: () => Promise<void>;
  updateSettings: (patch: Partial<SyncSettings>) => Promise<void>;
}

/** Polls real sync status from the backend, faster while a run is open. */
export function useSync(): UseSync {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [busy, setBusy] = useState(false);
  const activeRef = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await syncClient.getStatus();
      activeRef.current = next.state !== "idle";
      setStatus(next);
      setUnreachable(false);
    } catch (e) {
      activeRef.current = false;
      if (e instanceof BackendUnreachableError) setUnreachable(true);
      else setError(e instanceof Error ? e.message : "Unknown error");
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const loop = async () => {
      await refresh();
      if (stopped) return;
      timer = window.setTimeout(loop, activeRef.current ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    void loop();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        setError(null);
      } catch (e) {
        if (e instanceof BackendUnreachableError) setUnreachable(true);
        else setError(e instanceof Error ? e.message : "Unknown error");
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
    unreachable,
    busy,
    startSync: (mode) => act(() => syncClient.start(mode)),
    pause: () => act(() => syncClient.pause()),
    resume: () => act(() => syncClient.resume()),
    cancel: () => act(() => syncClient.cancel()),
    updateSettings: (patch) => act(() => syncClient.updateSettings(patch)),
  };
}
