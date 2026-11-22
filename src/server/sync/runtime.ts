import { getDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { DocsSourceStore } from "@/server/docs-source/store";
import { HybridFetcher } from "@/server/scraper/browser-fetcher";
import { createConfig } from "@/server/scraper/config";
import type { SyncApiDeps } from "@/server/sync/api";
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
 * One runtime per backend process. It lives on globalThis so Next.js dev-mode
 * module reloads never create a second scheduler (which would double-run syncs).
 */
const KEY = Symbol.for("gtps-assistant.sync-runtime");
type Holder = typeof globalThis & { [KEY]?: SyncRuntime };

export function getSyncRuntime(): SyncRuntime {
  const holder = globalThis as Holder;
  if (!holder[KEY]) {
    const repo = new Repository(getDatabase());
    const docsSource = new DocsSourceStore(repo);
    const service = new SyncService({
      repo,
      config: createConfig({ startUrl: docsSource.get().sourceUrl }),
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
