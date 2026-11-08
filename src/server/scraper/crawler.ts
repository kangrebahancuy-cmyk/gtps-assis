import { randomUUID } from "node:crypto";

import type { Repository } from "@/server/db/repository";
import type { ScraperConfig } from "@/server/scraper/config";
import type { ExtractedPage } from "@/server/scraper/extractor";
import { FetchError, type PageFetcher } from "@/server/scraper/fetcher";
import { RateLimiter, type Sleep, defaultSleep } from "@/server/scraper/rate-limiter";
import { ALLOW_ALL, DISALLOW_ALL, parseRobots, type RobotsPolicy } from "@/server/scraper/robots";
import { isDocumentationUrl, normalizeUrl } from "@/server/scraper/url";
import type { ScraperMode } from "@/types/scraper";

export interface CrawlProgressEvent {
  processed: number;
  total: number;
  currentUrl: string | null;
}

export interface CrawlSummary {
  runId: string;
  cancelled: boolean;
  scraped: number;
  failed: number;
  duplicates: number;
  blocked: number;
  discovered: number;
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
}

async function defaultLoadRobots(
  origin: string,
  config: ScraperConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const response = await fetch(`${origin}/robots.txt`, {
    headers: { "user-agent": config.userAgent },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]) : AbortSignal.timeout(config.timeoutMs),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) throw new Error(`robots.txt returned HTTP ${response.status}`);
  return response.text();
}

export class Crawler {
  constructor(private readonly deps: CrawlerDeps) {}

  async run(mode: ScraperMode, signal?: AbortSignal): Promise<CrawlSummary> {
    const { config, repo, fetcher } = this.deps;
    const sleep = this.deps.sleep ?? defaultSleep;
    const runId = randomUUID();
    const log = (level: "info" | "warn" | "error", message: string, url: string | null = null) =>
      repo.log(level, message, url, runId);

    const summary: CrawlSummary = {
      runId, cancelled: false, scraped: 0, failed: 0, duplicates: 0, blocked: 0, discovered: 0,
    };

    log("info", `Run started (${mode}). Start URL: ${config.startUrl}`);

    const extract = this.deps.extract ?? (await import("@/server/scraper/extractor")).extractPage;

    // ---- robots.txt ------------------------------------------------------
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
      // Cannot confirm what is allowed, so be conservative and do not crawl.
      robots = DISALLOW_ALL;
      log("error", `Could not read robots.txt, refusing to crawl: ${error instanceof Error ? error.message : String(error)}`);
      repo.setMeta("last_run_error", "robots.txt could not be read");
      return summary;
    }

    const limiter = new RateLimiter(
      Math.max(config.requestDelayMs, robots.crawlDelayMs ?? 0),
      sleep,
    );

    // ---- queue -----------------------------------------------------------
    const start = normalizeUrl(config.startUrl);
    if (!start) throw new Error(`Invalid start URL: ${config.startUrl}`);

    let queue: string[];
    if (mode === "retry") {
      repo.requeueFailed();
      queue = repo.listUrlsByStatus("pending");
      log("info", `Retrying ${queue.length} failed page(s)`);
    } else {
      repo.requeueAll();
      repo.discoverUrl(start, null);
      queue = repo.listUrlsByStatus("pending");
    }

    const seen = new Set<string>(queue);
    let processed = 0;
    const parents = new Map<string, string | null>([[start, null]]);

    while (queue.length > 0) {
      if (signal?.aborted) { summary.cancelled = true; break; }
      if (processed >= config.maxPages) {
        log("warn", `Stopped at the maxPages safety limit (${config.maxPages})`);
        break;
      }
      const url = queue.shift() as string;

      this.deps.onProgress?.({ processed, total: processed + queue.length + 1, currentUrl: url });

      if (!robots.isAllowed(url)) {
        repo.setUrlStatus(url, "blocked", { error: "Disallowed by robots.txt" });
        summary.blocked += 1;
        log("warn", "Skipped: disallowed by robots.txt", url);
        processed += 1;
        continue;
      }

      await limiter.wait(signal);
      if (signal?.aborted) { summary.cancelled = true; break; }

      try {
        const fetched = await fetcher.fetchPage(url, signal);

        // A redirect may leave the documentation area: do not follow it out.
        const finalUrl = normalizeUrl(fetched.finalUrl) ?? url;
        if (!isDocumentationUrl(finalUrl, config)) {
          throw new FetchError("http", `Redirected outside documentation area: ${finalUrl}`);
        }

        const page = extract(fetched.html, finalUrl, config);

        if (page.cleanedContent.length < config.minContentLength) {
          throw new FetchError("not-html", "Empty or invalid content: no readable text extracted");
        }

        // Discover newly found internal links.
        for (const link of page.docLinks) {
          if (!seen.has(link)) {
            seen.add(link);
            if (repo.discoverUrl(link, url)) {
              parents.set(link, url);
              queue.push(link);
              summary.discovered += 1;
            }
          }
        }

        const original = repo.findDocumentByHash(page.contentHash);
        if (original && original.url !== finalUrl) {
          repo.setUrlStatus(url, "duplicate", { httpStatus: fetched.httpStatus, error: `Same content as ${original.url}` });
          summary.duplicates += 1;
          log("info", `Duplicate content of ${original.url}`, url);
        } else {
          const outcome = repo.saveDocument(page, parents.get(url) ?? null);
          repo.setUrlStatus(url, "scraped", { httpStatus: fetched.httpStatus, incrementAttempts: true });
          summary.scraped += 1;
          log("info", `Scraped (${outcome}, ${fetched.rendered}): ${page.codeExamples.length} code block(s), ${page.apiEntries.length} API entr${page.apiEntries.length === 1 ? "y" : "ies"}`, url);
        }
      } catch (error) {
        if (error instanceof FetchError && error.kind === "aborted") {
          summary.cancelled = true;
          queue.unshift(url);
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        const httpStatus = error instanceof FetchError ? error.httpStatus : null;
        repo.setUrlStatus(url, "failed", { httpStatus, error: message, incrementAttempts: true });
        summary.failed += 1;
        log("error", message, url);
      }
      processed += 1;
    }

    this.deps.onProgress?.({ processed, total: processed + queue.length, currentUrl: null });
    repo.setMeta("last_run_at", new Date().toISOString());
    if (summary.scraped > 0) repo.setMeta("last_scraped_at", new Date().toISOString());
    repo.setMeta("last_run_error", "");
    log(
      summary.cancelled ? "warn" : "info",
      `Run ${summary.cancelled ? "cancelled" : "finished"}: ${summary.scraped} scraped, ${summary.failed} failed, ${summary.duplicates} duplicate, ${summary.blocked} blocked`,
    );
    return summary;
  }
}
