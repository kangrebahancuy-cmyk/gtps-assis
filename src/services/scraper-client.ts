import type {
  ScrapedDocumentSummary,
  ScraperLogEntry,
  ScraperMode,
  ScraperStatusResponse,
} from "@/types/scraper";

export class ScraperApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ScraperApiError("Could not reach the server.");
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof data === "object" && data !== null && "error" in data
        ? String((data as { error: unknown }).error)
        : `Request failed (HTTP ${response.status})`;
    throw new ScraperApiError(message);
  }
  return data as T;
}

export const scraperClient = {
  getStatus: () => request<ScraperStatusResponse>("/api/scraper/status"),
  start: (mode: ScraperMode) =>
    request<{ started: boolean }>("/api/scraper/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  cancel: () => request<{ cancelling: boolean }>("/api/scraper/cancel", { method: "POST" }),
  getLogs: async (limit = 200) =>
    (await request<{ logs: ScraperLogEntry[] }>(`/api/scraper/logs?limit=${limit}`)).logs,
  getDocuments: async () =>
    (await request<{ documents: ScrapedDocumentSummary[] }>("/api/docs")).documents,
};
