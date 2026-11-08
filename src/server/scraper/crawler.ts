import { randomUUID } from "node:crypto";

import type { Repository } from "@/server/db/repository";
import type { ScraperConfig } from "@/server/scraper/config";
import type { ExtractedPage } from "@/server/scraper/extractor";
import { FetchError, type PageFetcher } from "@/server/scraper/fetcher";
import { RateLimiter, type Sleep, defaultSleep } from "@/server/scraper/rate-limiter";
import { ALLOW_ALL, parseRobots, type RobotsPolicy } from "@/server/scraper/robots";
import { isDocumentationUrl, normalizeUrl } from "@/server/scraper/url";
import { EMPTY_COUNTS, type ChangeCounts, type SyncMode } from "@/types/sync";

export interface CrawlProgressEvent {
  processed: number;
  total: number;
  currentUrl: string | null;
  counts: ChangeCounts;
}

export interface CrawlSummary {
  runId: string;
  mode: SyncMode;
  cancelled: boolean;
  /** Set when the run could not start at all (e.g. robots.txt unreadable). */
  aborted: string | null;
  /** True when the maxPages safety limit left URLs unprocessed. */
  truncated: boolean;
  counts: ChangeCounts;
  /** URLs seen for the first time during this run. */
  discovered: number;
}

/** Lets a caller hold the crawler between pages (pause/resume). */
export interface RunControl {
  waitIfPaused(signal?: AbortSignal): Promise<void>;
}

export interface CrawlerDeps {
  config: ScraperConfig;
  repo: Repository;
  fetcher: PageFetcher;
  /** Fetches robots.txt text. Return null when the file does not exist (404). */
  loadRobots?: (origin: string, signal?: AbortSignal) => Promise<string | null>;
  sleep?: Sleep;
  onProgress?: (event: CrawlProgressEvent) => void;
  /** HTML -> structured page. Defaults to the Cheerio extractor (loaded lazily). */
  extract?: (html: string, url: string, config: ScraperConfig) => ExtractedPage;
  control?: RunControl;
  /** Id used for log rows. Generated when omitted. */
  runId?: string;
}

async function defaultLoadRobots(
  origin: string,
  config: ScraperConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const response = await fetch(`${origin}/robots.txt`, {
    headers: { "user-agent": config.userAgent },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`robots.txt returned HTTP ${response.status}`);
  return response.text();
}

const isGone = (error: unknown): error is FetchError =>
  error instanceof FetchError &&
  error.kind === "http" &&
  (error.httpStatus === 404 || error.httpStatus === 410);

export class Crawler {
  constructor(private readonly deps: CrawlerDeps) {}

  async run(mode: SyncMode, signal?: AbortSignal): Promise<CrawlSummary> {
    const { config, repo, fetcher, control } = this.deps;
    const sleep = this.deps.sleep ?? defaultSleep;
    const runId = this.deps.runId ?? randomUUID();
    const counts: ChangeCounts = { ...EMPTY_COUNTS };
    const summary: CrawlSummary = {
      runId, mode, cancelled: false, aborted: null, truncated: false, counts, discovered: 0,
    };
    const log = (level: "info" | "warn" | "error", message: string, url: string | null = null) =>
      repo.log(level, message, url, runId);

    log("info", `Sync started (${mode}). Start URL: ${config.startUrl}`);

    const extract = this.deps.extract ?? (await import("@/server/scraper/extractor")).extractPage;

    // ---- robots.txt: if it cannot be read, nothing is crawled and nothing is changed
    let robots: RobotsPolicy = ALLOW_ALL;
    try {
      const text = await (this.deps.loadRobots
        ? this.deps.loadRobots(config.origin, signal)
        : defaultLoadRobots(config.origin, config, signal));
      if (text === null) {
        log("info", "robots.txt not found (404); no crawl restrictions published");
      } else {
        robots = parseRobots(text, "GTPSAssistantBot");
        log("info", `robots.txt loaded (crawl-delay: ${robots.crawlDelayMs ?? "none"})`);
      }
    } catch (error) {
      if (signal?.aborted) {
        summary.cancelled = true;
        log("warn", "Sync cancelled before it started");
        return summary;
      }
      const reason = `Could not read robots.txt, refusing to crawl: ${error instanceof Error ? error.message : String(error)}`;
      summary.aborted = reason;
      log("error", `${reason}. The existing index was not changed.`);
      return summary;
    }

    const limiter = new RateLimiter(Math.max(config.requestDelayMs, robots.crawlDelayMs ?? 0), sleep);

    // ---- queue ----------------------------------------------------------
    const start = normalizeUrl(config.startUrl);
    if (!start) throw new Error(`Invalid start URL: ${config.startUrl}`);

    if (mode === "retry") {
      repo.requeueForSync("retry");
    } else {
      repo.discoverUrl(start, null);
      repo.requeueForSync(mode);
    }
    const queue = repo.listUrlsByStatus("pending");
    const startIndex = queue.indexOf(start);
    if (startIndex > 0) queue.unshift(...queue.splice(startIndex, 1)); // nav lives on the start page
    if (mode === "retry") log("info", `Retrying ${queue.length} failed page(s)`);
    else log("info", `Checking ${queue.length} known page(s)`);

    const seen = new Set<string>(queue);
    const parents = new Map<string, string | null>([[start, null]]);
    let processed = 0;

    const emit = (currentUrl: string | null) =>
      this.deps.onProgress?.({
        processed,
        total: processed + queue.length + (currentUrl ? 1 : 0),
        currentUrl,
        counts: { ...counts },
      });

    while (queue.length > 0) {
      // Publish the finished-page state before any wait, so counters stay accurate while paused.
      emit(null);
      await control?.waitIfPaused(signal);
      if (signal?.aborted) { summary.cancelled = true; break; }
      if (processed >= config.maxPages) {
        summary.truncated = true;
        log("warn", `Stopped at the maxPages safety limit (${config.maxPages}); ${queue.length} URL(s) left unprocessed`);
        break;
      }
      const url = queue.shift() as string;
      emit(url);

      if (!robots.isAllowed(url)) {
        repo.setUrlStatus(url, "blocked", { error: "Disallowed by robots.txt" });
        counts.blocked += 1;
        log("warn", "Skipped: disallowed by robots.txt", url);
        processed += 1;
        continue;
      }

      await limiter.wait(signal);
      if (signal?.aborted) { summary.cancelled = true; queue.unshift(url); break; }

      try {
        // The start page is always fetched in full because it carries the navigation
        // that reveals newly added pages.
        const stored = mode === "incremental" && url !== start ? repo.getValidators(url) : null;
        const validators = stored && (stored.etag || stored.lastModified) ? stored : null;
        const fetched = await fetcher.fetchPage(url, signal, validators);

        if (fetched.notModified) {
          repo.touchDocument(url);
          repo.setUrlStatus(url, "scraped", { httpStatus: fetched.httpStatus, incrementAttempts: true });
          counts.unchanged += 1;
          log("info", "Unchanged (304 Not Modified, not reprocessed)", url);
          processed += 1;
          continue;
        }

        // A redirect may leave the documentation area: do not follow it out.
        const finalUrl = normalizeUrl(fetched.finalUrl) ?? url;
        if (!isDocumentationUrl(finalUrl, config)) {
          throw new FetchError("http", `Redirected outside documentation area: ${finalUrl}`);
        }

        const page = extract(fetched.html, finalUrl, config);
        if (page.cleanedContent.length < config.minContentLength) {
          throw new FetchError("not-html", "Empty or invalid content: no readable text extracted");
        }

        for (const link of page.docLinks) {
          if (seen.has(link)) continue;
          seen.add(link);
          if (repo.queueLink(link, url)) {
            parents.set(link, url);
            queue.push(link);
            summary.discovered += 1;
          }
        }

        const original = repo.findDocumentByHash(page.contentHash);
        if (original && original.url !== finalUrl) {
          repo.setUrlStatus(url, "duplicate", { httpStatus: fetched.httpStatus, error: `Same content as ${original.url}` });
          counts.duplicates += 1;
          log("info", `Duplicate content of ${original.url}`, url);
        } else {
          // Validators from a browser-rendered page describe the empty HTML shell,
          // not the rendered content, so they are not stored for those pages.
          const keep = fetched.rendered === "static";
          const outcome = repo.saveDocument(page, parents.get(url) ?? null, {
            etag: keep ? fetched.etag ?? null : null,
            lastModified: keep ? fetched.lastModified ?? null : null,
          });
          repo.setUrlStatus(url, "scraped", { httpStatus: fetched.httpStatus, incrementAttempts: true });
          const detail = `${page.codeExamples.length} code block(s), ${page.apiEntries.length} API entr${page.apiEntries.length === 1 ? "y" : "ies"}`;
          if (outcome === "inserted") { counts.added += 1; log("info", `New page added (${detail})`, url); }
          else if (outcome === "updated") { counts.updated += 1; log("info", `Content changed, updated (${detail})`, url); }
          else if (outcome === "restored") { counts.updated += 1; log("info", "Page is available again; restored", url); }
          else { counts.unchanged += 1; log("info", "Unchanged (same content hash, not rewritten)", url); }
        }
      } catch (error) {
        if (error instanceof FetchError && error.kind === "aborted") {
          summary.cancelled = true;
          queue.unshift(url);
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        const httpStatus = error instanceof FetchError ? error.httpStatus : null;

        if (isGone(error) && repo.hasActiveDocument(url)) {
          // The source answered "gone". Keep the text locally but flag it as deleted.
          repo.markDeleted(url);
          repo.setUrlStatus(url, "deleted", { httpStatus, error: message, incrementAttempts: true });
          counts.deleted += 1;
          log("warn", `No longer available at the source (${message}); kept locally and marked deleted`, url);
        } else if (isGone(error) && repo.isMarkedDeleted(url)) {
          repo.setUrlStatus(url, "deleted", { httpStatus, error: message, incrementAttempts: true });
          log("info", "Still unavailable at the source", url);
        } else {
          // Any other problem (network, timeout, 5xx, 429, bad content) is treated as
          // temporary: the page is marked failed but its indexed copy is left alone.
          repo.setUrlStatus(url, "failed", { httpStatus, error: message, incrementAttempts: true });
          counts.failed += 1;
          const kept = repo.hasActiveDocument(url) ? " (existing indexed copy kept)" : "";
          log("error", `${message}${kept}`, url);
        }
      }
      processed += 1;
    }

    emit(null);
    const verb = summary.cancelled ? "cancelled" : "finished";
    log(
      summary.cancelled ? "warn" : "info",
      `Sync ${verb}: ${counts.added} new, ${counts.updated} updated, ${counts.unchanged} unchanged, ${counts.deleted} deleted, ${counts.failed} failed, ${counts.duplicates} duplicate, ${counts.blocked} blocked`,
    );
    return summary;
  }
}
