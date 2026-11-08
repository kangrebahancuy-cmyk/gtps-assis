import { getDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { HybridFetcher } from "@/server/scraper/browser-fetcher";
import { createConfig } from "@/server/scraper/config";
import { Crawler, type CrawlProgressEvent } from "@/server/scraper/crawler";
import type {
  ScraperMode,
  ScraperRunStatus,
  ScraperStatusResponse,
} from "@/types/scraper";

interface JobState {
  status: ScraperRunStatus;
  mode: ScraperMode | null;
  progress: CrawlProgressEvent;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  controller: AbortController | null;
}

/**
 * Holds the single running crawl. Stored on globalThis so Next.js dev-mode
 * module reloads do not lose track of a job that is still running.
 */
const globalKey = Symbol.for("gtps-assistant.scraper-job");
type GlobalWithJob = typeof globalThis & { [globalKey]?: JobState };

function state(): JobState {
  const g = globalThis as GlobalWithJob;
  g[globalKey] ??= {
    status: "idle",
    mode: null,
    progress: { processed: 0, total: 0, currentUrl: null },
    startedAt: null,
    finishedAt: null,
    error: null,
    controller: null,
  };
  return g[globalKey];
}

export type StartResult =
  | { ok: true }
  | { ok: false; reason: "already-running" | "nothing-to-retry" };

export function startScrape(mode: ScraperMode): StartResult {
  const job = state();
  if (job.status === "running" || job.status === "cancelling") {
    return { ok: false, reason: "already-running" };
  }

  const repo = new Repository(getDatabase());
  if (mode === "retry" && repo.getStats().failed === 0) {
    return { ok: false, reason: "nothing-to-retry" };
  }

  const controller = new AbortController();
  job.status = "running";
  job.mode = mode;
  job.controller = controller;
  job.error = null;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.progress = { processed: 0, total: 0, currentUrl: null };

  const config = createConfig();
  const fetcher = new HybridFetcher(config);
  const crawler = new Crawler({
    config,
    repo,
    fetcher,
    onProgress: (event) => {
      job.progress = event;
    },
  });

  void crawler
    .run(mode, controller.signal)
    .then((summary) => {
      job.status = summary.cancelled ? "cancelled" : "completed";
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      job.status = "failed";
      job.error = message;
      repo.log("error", `Run crashed: ${message}`);
    })
    .finally(async () => {
      job.finishedAt = new Date().toISOString();
      job.controller = null;
      await fetcher.close();
    });

  return { ok: true };
}

export function cancelScrape(): boolean {
  const job = state();
  if (job.status !== "running" || !job.controller) return false;
  job.status = "cancelling";
  job.controller.abort();
  return true;
}

export function getStatus(): ScraperStatusResponse {
  const job = state();
  const repo = new Repository(getDatabase());
  const stats = repo.getStats();
  const { processed, total, currentUrl } = job.progress;
  const active = job.status === "running" || job.status === "cancelling";

  return {
    status: job.status,
    mode: job.mode,
    stats,
    progress: {
      processed,
      total,
      percent: total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : active ? 0 : job.status === "idle" ? 0 : 100,
      currentUrl: active ? currentUrl : null,
    },
    lastScrapedAt: repo.getMeta("last_scraped_at") || null,
    lastRunStartedAt: job.startedAt,
    lastRunFinishedAt: job.finishedAt,
    lastError: job.error ?? (repo.getMeta("last_run_error") || null),
    failedPages: repo.listFailed(),
  };
}
