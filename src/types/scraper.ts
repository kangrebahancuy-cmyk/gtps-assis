/** Types shared by the scraper backend and the Documentation UI. */

export type CrawlUrlStatus =
  | "pending"
  | "scraped"
  | "failed"
  | "duplicate"
  | "blocked"
  | "deleted";

export interface FailedPage {
  url: string;
  error: string | null;
  httpStatus: number | null;
  attempts: number;
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
