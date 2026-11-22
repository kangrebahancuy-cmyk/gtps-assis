import { getDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { DocsSourceStore } from "@/server/docs-source/store";
import { HybridFetcher } from "@/server/scraper/browser-fetcher";
import { createConfig, type ScraperConfig } from "@/server/scraper/config";
import type { SyncApiDeps } from "@/server/sync/api";
import { hostedPlatform } from "@/server/platform";
import { Scheduler } from "@/server/sync/scheduler";
import { SyncService } from "@/server/sync/sync-service";
import type { SyncStatus } from "@/types/sync";

interface SyncRuntime {
  repo: Repository;
  service: SyncService;
  scheduler: Scheduler;
  docsSource: DocsSourceStore;
}

/**
 * A serverless function lives for at most about a minute and has no browser, so on a host the crawl is quicker,
 * HTTP-only, stops before the time limit and continues where it stopped the next time it is started.
 */
export function hostedScraperOverrides(env: Record<string, string | undefined> = process.env): Partial<ScraperConfig> {
  if (hostedPlatform(env) === null) return {};
  return { requestDelayMs: 250, renderMode: "static", deadlineMs: 45_000, resumeUnfinished: true };
}

/**
 * One runtime per backend process. It lives on globalThis so Next.js dev-mode
 * module reloads never create a second scheduler (which would double-run syncs).
 */
const KEY = Symbol.for("gtps-assistant.sync-runtime");
const RECOVERED = Symbol.for("gtps-assistant.runs-recovered");
type Holder = typeof globalThis & { [KEY]?: SyncRuntime };

export function getSyncRuntime(): SyncRuntime {
  const holder = globalThis as Holder;
  if (!holder[KEY]) {
    const repo = new Repository(getDatabase());
    const docsSource = new DocsSourceStore(repo);
    const service = new SyncService({
      repo,
      config: createConfig({ startUrl: docsSource.get().sourceUrl, ...hostedScraperOverrides() }),
      createFetcher: (config) => new HybridFetcher(config, () => docsSource.get().extraDomains),
    });
    holder[KEY] = { repo, service, scheduler: new Scheduler({ repo, service }), docsSource };
  }
  return holder[KEY];
}

/**
 * Starts the persistent scheduler. Called once when the server boots
 * (src/instrumentation.ts) and again, harmlessly, by the status route as a
 * safety net. Runs left "running" by a previous process are closed first.
 */
export function startBackgroundServices(): SyncRuntime {
  const runtime = getSyncRuntime();
  // No background timer on a host (the function sleeps between requests). Runs left open by an earlier
  // instance are closed once, when this instance is created, never while a request of this one is crawling.
  if (hostedPlatform() !== null) {
    const holder = globalThis as typeof globalThis & { [RECOVERED]?: boolean };
    if (!holder[RECOVERED]) {
      holder[RECOVERED] = true;
      runtime.repo.recoverInterruptedRuns();
    }
    return runtime;
  }
  if (!runtime.scheduler.getStatus().running) {
    runtime.repo.recoverInterruptedRuns();
    runtime.scheduler.start();
  }
  return runtime;
}

export function getFullStatus(): SyncStatus {
  const { service, scheduler } = startBackgroundServices();
  return { ...service.getStatus(), scheduler: scheduler.getStatus() };
}

/** Everything the /api/sync and /api/docs-source handlers need, from the process-wide runtime. */
export function getSyncApiDeps(): SyncApiDeps {
  const { service, scheduler, repo, docsSource } = startBackgroundServices();
  return { service, scheduler, repo, docsSource, status: getFullStatus };
}
