/** Types shared by the scraper backend and the Documentation dashboard. */

export type ScraperRunStatus =
  | "idle"
  | "running"
  | "cancelling"
  | "completed"
  | "cancelled"
  | "failed";

export type ScraperMode = "full" | "retry";

export type CrawlUrlStatus =
  | "pending"
  | "scraped"
  | "failed"
  | "duplicate"
  | "blocked";

export interface ScraperStats {
  /** Every distinct documentation URL found by the crawler. */
  discovered: number;
  scraped: number;
  failed: number;
  pending: number;
  /** Pages skipped because another URL had identical content. */
  duplicates: number;
  /** Pages skipped because robots.txt disallows them. */
  blocked: number;
  /** Rows in the documents table. */
  documents: number;
}

export interface ScraperProgress {
  processed: number;
  total: number;
  percent: number;
  currentUrl: string | null;
}

export interface FailedPage {
  url: string;
  error: string | null;
  httpStatus: number | null;
  attempts: number;
}

export interface ScraperStatusResponse {
  status: ScraperRunStatus;
  mode: ScraperMode | null;
  stats: ScraperStats;
  progress: ScraperProgress;
  lastScrapedAt: string | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastError: string | null;
  failedPages: FailedPage[];
}

export type LogLevel = "info" | "warn" | "error";

export interface ScraperLogEntry {
  id: number;
  runId: string | null;
  level: LogLevel;
  url: string | null;
  message: string;
  createdAt: string;
}

export interface ScrapedDocumentSummary {
  id: number;
  title: string;
  url: string;
  category: string | null;
  cleanedContent: string;
  codeExampleCount: number;
  lastScrapedAt: string;
}
