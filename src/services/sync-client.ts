import type { ScraperLogEntry } from "@/types/scraper";
import type {
  SyncRequestMode,
  SyncRunRecord,
  SyncSettings,
  SyncStatus,
} from "@/types/sync";

/** The server could not be reached at all (as opposed to answering with an error). */
export class BackendUnreachableError extends Error {
  constructor() {
    super("Cannot reach the local backend.");
  }
}

export class SyncApiError extends Error {}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new BackendUnreachableError();
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (HTTP ${response.status})`;
    throw new SyncApiError(message);
  }
  return data as T;
}

const post = (path: string, body?: unknown) =>
  request<unknown>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const syncClient = {
  getStatus: () => request<SyncStatus>("/api/sync/status"),
  start: (mode: SyncRequestMode) => post("/api/sync/start", { mode }),
  pause: () => post("/api/sync/pause"),
  resume: () => post("/api/sync/resume"),
  cancel: () => post("/api/sync/cancel"),
  updateSettings: (patch: Partial<SyncSettings>) =>
    request<SyncSettings>("/api/sync/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  getLogs: async (limit = 200, runId?: string) =>
    (
      await request<{ logs: ScraperLogEntry[] }>(
        `/api/sync/logs?limit=${limit}${runId ? `&runId=${encodeURIComponent(runId)}` : ""}`,
      )
    ).logs,
  getRuns: async () => (await request<{ runs: SyncRunRecord[] }>("/api/sync/runs")).runs,
};
