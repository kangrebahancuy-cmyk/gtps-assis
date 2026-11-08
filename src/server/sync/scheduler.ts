import type { Repository } from "@/server/db/repository";
import type { SyncService } from "@/server/sync/sync-service";
import {
  DEFAULT_INTERVAL_MINUTES,
  MAX_INTERVAL_MINUTES,
  MIN_INTERVAL_MINUTES,
  type SchedulerStatus,
  type SyncSettings,
} from "@/types/sync";

const KEY = {
  enabled: "sync.auto_enabled",
  interval: "sync.interval_minutes",
  paused: "sync.schedule_paused",
  next: "sync.next_run_at",
  heartbeat: "sync.heartbeat_at",
  lastScheduled: "sync.last_scheduled_run_at",
  downtime: "sync.downtime_notice",
} as const;

export const DEFAULT_TICK_MS = 15_000;

export class SettingsError extends Error {}

export interface SchedulerDeps {
  repo: Repository;
  service: Pick<SyncService, "start" | "isBusy" | "onFinish">;
  now?: () => Date;
  tickMs?: number;
}

/**
 * Persistent scheduler for automatic synchronization.
 *
 * It lives in the backend (Node) process, not in the browser, so closing the
 * tab does not stop it. It does stop when the backend process stops, and it
 * reports that honestly: status.running/healthy come from a heartbeat written
 * on every tick, and a run that came due while the backend was down is noted.
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly tickMs: number;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
    deps.service.onFinish(() => this.afterRun());
  }

  // ---- settings -----------------------------------------------------------

  getSettings(): SyncSettings {
    const { repo } = this.deps;
    const interval = Number(repo.getMeta(KEY.interval));
    return {
      autoEnabled: repo.getMeta(KEY.enabled) === "1",
      intervalMinutes: Number.isInteger(interval) && interval >= MIN_INTERVAL_MINUTES ? interval : DEFAULT_INTERVAL_MINUTES,
      schedulePaused: repo.getMeta(KEY.paused) === "1",
    };
  }

  updateSettings(patch: Partial<SyncSettings>): SyncSettings {
    const before = this.getSettings();
    const next: SyncSettings = { ...before };

    if (patch.intervalMinutes !== undefined) {
      const value = patch.intervalMinutes;
      if (!Number.isInteger(value) || value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) {
        throw new SettingsError(
          `Interval must be a whole number of minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`,
        );
      }
      next.intervalMinutes = value;
    }
    for (const field of ["autoEnabled", "schedulePaused"] as const) {
      const value = patch[field];
      if (value === undefined) continue;
      if (typeof value !== "boolean") throw new SettingsError(`${field} must be true or false.`);
      next[field] = value;
    }

    const { repo } = this.deps;
    repo.setMeta(KEY.enabled, next.autoEnabled ? "1" : "0");
    repo.setMeta(KEY.interval, String(next.intervalMinutes));
    repo.setMeta(KEY.paused, next.schedulePaused ? "1" : "0");

    const changed =
      before.autoEnabled !== next.autoEnabled ||
      before.schedulePaused !== next.schedulePaused ||
      before.intervalMinutes !== next.intervalMinutes;
    if (changed) this.scheduleNext(next);
    return next;
  }

  // ---- lifecycle ----------------------------------------------------------

  start(): void {
    if (this.timer) return;
    const now = this.now();
    const settings = this.getSettings();
    const due = this.deps.repo.getMeta(KEY.next);
    if (settings.autoEnabled && !settings.schedulePaused && due && Date.parse(due) < now.getTime() - this.tickMs) {
      const notice = `A scheduled sync was due at ${due} but the backend was not running. It will run now.`;
      this.deps.repo.setMeta(KEY.downtime, notice);
      this.deps.repo.log("warn", notice);
    }
    this.tick();
    this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scheduler step. Public so tests can drive it with a fake clock. */
  tick(): void {
    const { repo, service } = this.deps;
    const now = this.now();
    repo.setMeta(KEY.heartbeat, now.toISOString());

    const settings = this.getSettings();
    if (!settings.autoEnabled || settings.schedulePaused) {
      if (repo.getMeta(KEY.next)) repo.setMeta(KEY.next, "");
      return;
    }

    const next = repo.getMeta(KEY.next);
    if (!next) {
      if (!service.isBusy()) this.scheduleNext(settings);
      return;
    }
    if (Date.parse(next) > now.getTime()) return;
    if (service.isBusy()) return; // stay due; never stack runs

    repo.setMeta(KEY.lastScheduled, now.toISOString());
    const result = service.start("auto", "scheduled");
    if (result.ok) {
      repo.setMeta(KEY.next, ""); // re-armed when the run finishes
      repo.log("info", `Scheduled ${result.mode} sync started`, null, result.runId);
    } else {
      this.scheduleNext(settings);
      repo.log("warn", `Scheduled sync could not start (${result.reason})`);
    }
  }

  private afterRun(): void {
    const settings = this.getSettings();
    this.deps.repo.setMeta(KEY.downtime, "");
    if (settings.autoEnabled && !settings.schedulePaused) this.scheduleNext(settings);
  }

  private scheduleNext(settings: SyncSettings): void {
    const { repo } = this.deps;
    if (!settings.autoEnabled || settings.schedulePaused) {
      repo.setMeta(KEY.next, "");
      return;
    }
    repo.setMeta(KEY.next, new Date(this.now().getTime() + settings.intervalMinutes * 60_000).toISOString());
  }

  // ---- status -------------------------------------------------------------

  getStatus(): SchedulerStatus {
    const { repo } = this.deps;
    const settings = this.getSettings();
    const heartbeat = repo.getMeta(KEY.heartbeat) || null;
    const running = this.timer !== null;
    const age = heartbeat ? this.now().getTime() - Date.parse(heartbeat) : Infinity;
    return {
      running,
      healthy: running && age <= this.tickMs * 3,
      heartbeatAt: heartbeat,
      enabled: settings.autoEnabled,
      schedulePaused: settings.schedulePaused,
      intervalMinutes: settings.intervalMinutes,
      nextRunAt: repo.getMeta(KEY.next) || null,
      lastScheduledRunAt: repo.getMeta(KEY.lastScheduled) || null,
      downtimeNotice: repo.getMeta(KEY.downtime) || null,
    };
  }
}
