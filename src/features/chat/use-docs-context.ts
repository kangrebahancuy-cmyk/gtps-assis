"use client";

import { useEffect, useState } from "react";

import { docsClient } from "@/services/docs-client";
import type { DocsContextStatus } from "@/types/rag";

export type DocsContextState = { phase: "loading" } | { phase: "ready"; status: DocsContextStatus } | { phase: "unreachable" };

/** What is indexed right now (read from the backend). Reloaded whenever `refreshKey` changes, e.g. after a reply. */
export function useDocsContext(refreshKey: unknown): DocsContextState {
  const [state, setState] = useState<DocsContextState>({ phase: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    docsClient
      .context(abort.signal)
      .then((status) => {
        if (abort.signal.aborted) return;
        // An interrupted or malformed answer must never be shown as "ready": it would crash the indicator.
        const valid = typeof status === "object" && status !== null && typeof status.available === "boolean" && typeof status.documents === "number" && typeof status.chunks === "number";
        setState(valid ? { phase: "ready", status } : { phase: "unreachable" });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ phase: "unreachable" });
      });
    return () => abort.abort();
  }, [refreshKey]);
  return state;
}
