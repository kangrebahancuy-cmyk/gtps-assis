import { randomUUID } from "node:crypto";

import type { Repository } from "@/server/db/repository";
import type { ScraperConfig } from "@/server/scraper/config";
import { Crawler, type CrawlerDeps } from "@/server/scraper/crawler";
import type { PageFetcher } from "@/server/scraper/fetcher";
import { PauseGate } from "@/server/sync/pause-gate";
import {
  EMPTY_COUNTS,
  type CurrentRun,
  type SyncMode,
  type SyncRequestMode,
  type SyncRunRecord,
  type SyncRunStatus,
  type SyncState,
  type SyncStatus,
  type SyncTrigger,
} from "@/types/sync";

export const META_LAST_SUCCESS = "sync.last_success_at";

export interface SyncServiceDeps {
  repo: Repository;
  config: ScraperConfig;
  createFetcher: (config: ScraperConfig) => PageFetcher;
  loadRobots?: CrawlerDeps["loadRobots"];
  extract?: CrawlerDeps["extract"];
  sleep?: CrawlerDeps["sleep"];
  now?: () => Date;
}

export type StartResult =
  | { ok: true; runId: string; mode: SyncMode }
  | { ok: false; reason: "already-running" | "nothing-to-retry" };

export type SyncServiceStatus = Omit<SyncStatus, "scheduler">;

/**
 * Runs one synchronization at a time on top of the crawler and records every
 * run in the database. It holds no timers; scheduling lives in Scheduler.
 */
export class SyncService {
  private state: SyncState = "idle";
  private current: CurrentRun | null = null;
  private controller: AbortController | null = null;
  private gate: PauseGate | null = null;
  private finished: Promise<void> = Promise.resolve();
  private readonly listeners: Array<(run: SyncRunRecord) => void> = [];
  private readonly now: () => Date;

  constructor(private readonly deps: SyncServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  isBusy(): boolean {
    return this.state !== "idle";
  }

  onFinish(listener: (run: SyncRunRecord) => void): void {
    this.listeners.push(listener);
  }

  /** Resolves when no run is active. Used by the CLI and tests. */
  whenIdle(): Promise<void> {
    return this.finished;
  }

  /** "auto" picks a full sync when nothing is indexed yet, otherwise incremental. */
  resolveMode(requested: SyncRequestMode): SyncMode {
    if (requested !== "auto") return requested;
    return this.deps.repo.getStats().documents > 0 ? "incremental" : "full";
  }

  start(requested: SyncRequestMode, trigger: SyncTrigger = "manual"): StartResult {
    if (this.state !== "idle") return { ok: false, reason: "already-running" };
    const { repo } = this.deps;
    const mode = this.resolveMode(requested);
    if (mode === "retry" && repo.getStats().failed === 0) {
      return { ok: false, reason: "nothing-to-retry" };
    }

    const runId = randomUUID();
    const startedAt = this.now().toISOString();
    repo.createRun(runId, mode, trigger, startedAt);

    this.state = "running";
    this.controller = new AbortController();
    this.gate = new PauseGate();
    this.current = {
      runId, mode, trigger, startedAt,
      counts: { ...EMPTY_COUNTS },
      progress: { processed: 0, total: 0, percent: 0, currentUrl: null },
    };

    this.finished = this.execute(runId, mode, trigger);
    return { ok: true, runId, mode };
  }

  pause(): boolean {
    if (this.state !== "running" || !this.gate || !this.current) return false;
    this.gate.pause();
    this.state = "paused";
    this.deps.repo.log("info", "Sync paused (takes effect before the next page)", null, this.current.runId);
    return true;
  }

  resume(): boolean {
    if (this.state !== "paused" || !this.gate || !this.current) return false;
    this.state = "running";
    this.deps.repo.log("info", "Sync resumed", null, this.current.runId);
    this.gate.resume();
    return true;
  }

  cancel(): boolean {
    if ((this.state !== "running" && this.state !== "paused") || !this.controller) return false;
    this.state = "cancelling";
    this.controller.abort();
    this.gate?.resume(); // release a paused crawler so it can stop
    return true;
  }

  getStatus(): SyncServiceStatus {
    const { repo } = this.deps;
    const lastRun = repo.listRuns(5).find((run) => run.status !== "running") ?? null;
    return {
      state: this.state,
      current: this.current ? structuredClone(this.current) : null,
      lastRun,
      lastSuccessAt: repo.getMeta(META_LAST_SUCCESS) || null,
      totals: repo.getTotals(),
      failedPages: repo.listFailed(),
    };
  }

  private async execute(runId: string, mode: SyncMode, trigger: SyncTrigger): Promise<void> {
    const { repo, config } = this.deps;
    const fetcher = this.deps.createFetcher(config);
    let status: SyncRunStatus = "failed";
    let error: string | null = null;
    let counts = { ...EMPTY_COUNTS };

    try {
      const crawler = new Crawler({
        config, repo, fetcher, runId,
        loadRobots: this.deps.loadRobots,
        extract: this.deps.extract,
        sleep: this.deps.sleep,
        control: this.gate ?? undefined,
        onProgress: (event) => {
          if (!this.current) return;
          this.current.counts = event.counts;
          this.current.progress = {
            processed: event.processed,
            total: event.total,
            percent: event.total > 0 ? Math.min(100, Math.round((event.processed / event.total) * 100)) : 0,
            currentUrl: event.currentUrl,
          };
        },
      });
      const summary = await crawler.run(mode, this.controller?.signal);
      counts = summary.counts;
      if (summary.aborted) {
        status = "failed";
        error = summary.aborted;
      } else if (summary.cancelled) {
        status = "cancelled";
      } else if (counts.failed > 0 || summary.truncated) {
        status = "completed_with_errors";
        error = summary.truncated ? "Stopped at the page limit before all URLs were processed." : null;
      } else {
        status = "completed";
      }
    } catch (e) {
      status = "failed";
      error = e instanceof Error ? e.message : String(e);
      counts = this.current?.counts ?? counts;
      repo.log("error", `Sync crashed: ${error}`, null, runId);
    } finally {
      await fetcher.close().catch(() => undefined);
    }

    repo.finishRun(runId, status, counts, error);
    if (status === "completed") repo.setMeta(META_LAST_SUCCESS, this.now().toISOString());

    const record = repo.listRuns(5).find((run) => run.id === runId);
    this.state = "idle";
    this.current = null;
    this.controller = null;
    this.gate = null;
    if (record) for (const listener of this.listeners) listener(record);
    void trigger;
  }
}
