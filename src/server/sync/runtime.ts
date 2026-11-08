import { getDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { HybridFetcher } from "@/server/scraper/browser-fetcher";
import { createConfig } from "@/server/scraper/config";
import { Scheduler } from "@/server/sync/scheduler";
import { SyncService } from "@/server/sync/sync-service";
import type { SyncStatus } from "@/types/sync";

interface SyncRuntime {
  repo: Repository;
  service: SyncService;
  scheduler: Scheduler;
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
    const service = new SyncService({
      repo,
      config: createConfig(),
      createFetcher: (config) => new HybridFetcher(config),
    });
    holder[KEY] = { repo, service, scheduler: new Scheduler({ repo, service }) };
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
