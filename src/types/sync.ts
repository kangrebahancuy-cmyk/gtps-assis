import type { FailedPage } from "@/types/scraper";

/** What a sync run does. "auto" is only a request value (resolved when started). */
export type SyncMode = "full" | "incremental" | "retry";
export type SyncRequestMode = SyncMode | "auto";
export type SyncTrigger = "manual" | "scheduled";

export type SyncRunStatus =
  | "running"
  | "completed"
  | "completed_with_errors"
  | "cancelled"
  | "failed"
  | "interrupted";

/** Live state of the sync engine. "paused" only exists while a run is open. */
export type SyncState = "idle" | "running" | "paused" | "cancelling";

/** Per-run outcome counters. Every number comes from real crawl results. */
export interface ChangeCounts {
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  deleted: number;
  duplicates: number;
  blocked: number;
}

export interface SyncProgress {
  processed: number;
  /** Processed plus still queued. Grows while new pages are discovered. */
  total: number;
  percent: number;
  currentUrl: string | null;
}

export interface SyncRunRecord {
  id: string;
  mode: SyncMode;
  trigger: SyncTrigger;
  status: SyncRunStatus;
  startedAt: string;
  finishedAt: string | null;
  counts: ChangeCounts;
  error: string | null;
}

export interface CurrentRun {
  runId: string;
  mode: SyncMode;
  trigger: SyncTrigger;
  startedAt: string;
  counts: ChangeCounts;
  progress: SyncProgress;
}

export interface SyncTotals {
  /** Documents currently in the index (excludes ones marked deleted). */
  documents: number;
  /** Documents kept locally but no longer available at the source. */
  deleted: number;
  /** URLs whose latest attempt failed and still need a retry. */
  failedOutstanding: number;
  discoveredUrls: number;
}

export interface SchedulerStatus {
  /** The backend timer loop exists in this process. */
  running: boolean;
  /** The loop reported a heartbeat recently. False means it is not really ticking. */
  healthy: boolean;
  heartbeatAt: string | null;
  enabled: boolean;
  schedulePaused: boolean;
  intervalMinutes: number;
  nextRunAt: string | null;
  lastScheduledRunAt: string | null;
  /** Set when the backend was stopped for a while and scheduled runs were missed. */
  downtimeNotice: string | null;
}

export interface SyncStatus {
  state: SyncState;
  current: CurrentRun | null;
  lastRun: SyncRunRecord | null;
  lastSuccessAt: string | null;
  totals: SyncTotals;
  failedPages: FailedPage[];
  scheduler: SchedulerStatus;
}

export interface SyncSettings {
  autoEnabled: boolean;
  intervalMinutes: number;
  schedulePaused: boolean;
}

export const MIN_INTERVAL_MINUTES = 5;
export const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
export const DEFAULT_INTERVAL_MINUTES = 60;

export const EMPTY_COUNTS: ChangeCounts = {
  added: 0,
  updated: 0,
  unchanged: 0,
  failed: 0,
  deleted: 0,
  duplicates: 0,
  blocked: 0,
};
