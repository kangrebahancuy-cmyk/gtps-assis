import type { Browser } from "playwright";

import type { ScraperConfig } from "@/server/scraper/config";
import {
  FetchError,
  fetchStatic,
  withRetries,
  type FetchedPage,
  type PageFetcher,
} from "@/server/scraper/fetcher";
import { looksClientRendered } from "@/server/scraper/extractor";

/**
 * Production page source. Fetches over plain HTTP first and falls back to a
 * Playwright-rendered page only when needed (renderMode "auto") or always
 * ("browser"). Playwright is imported lazily, so static mode never needs it.
 */
export class HybridFetcher implements PageFetcher {
  private browser: Browser | null = null;

  constructor(private readonly config: ScraperConfig) {}

  async fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage> {
    const { renderMode } = this.config;

    if (renderMode === "browser") return this.render(url, signal);

    const page = await withRetries(() => fetchStatic(url, this.config, signal), {
      maxRetries: this.config.maxRetries,
      backoffMs: this.config.retryBackoffMs,
      signal,
    });

    if (renderMode === "auto" && looksClientRendered(page.html)) {
      return this.render(url, signal);
    }
    return page;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    try {
      const { chromium } = await import("playwright");
      this.browser = await chromium.launch();
      return this.browser;
    } catch (error) {
      throw new FetchError(
        "browser",
        `Could not start the browser: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async render(url: string, signal?: AbortSignal): Promise<FetchedPage> {
    if (signal?.aborted) throw new FetchError("aborted", "Request cancelled");
    const browser = await this.getBrowser();
    const context = await browser.newContext({ userAgent: this.config.userAgent });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, {
        waitUntil: "networkidle",
        timeout: this.config.timeoutMs,
      });
      const status = response?.status() ?? 0;
      if (status >= 400) {
        throw new FetchError("http", `HTTP ${status} (browser)`, status);
      }
      return {
        finalUrl: page.url(),
        html: await page.content(),
        httpStatus: status || 200,
        rendered: "browser",
      };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (/timeout/i.test(message)) {
        throw new FetchError("timeout", `Browser timed out after ${this.config.timeoutMs} ms`);
      }
      throw new FetchError("browser", `Browser rendering error: ${message}`);
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }
}
