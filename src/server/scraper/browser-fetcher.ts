import type { Browser, Page } from "playwright";

import { isDomainApproved, isLoopbackHost, isPrivateHost } from "@/lib/docs-source";
import type { ScraperConfig } from "@/server/scraper/config";
import {
  FetchError,
  fetchStatic,
  withRetries,
  type FetchedPage,
  type PageFetcher,
  type RequestValidators,
} from "@/server/scraper/fetcher";
import { isDocumentationUrl, normalizeUrl } from "@/server/scraper/url";

/**
 * Production page source. Fetches over plain HTTP first and falls back to a
 * Playwright-rendered page only when needed (renderMode "auto") or always
 * ("browser"). Playwright is imported lazily, so static mode never needs it.
 */
export class HybridFetcher implements PageFetcher {
  private browser: Browser | null = null;

  /** @param extraDomains the hosts the local user explicitly allowed besides the approved ones (read per request). */
  constructor(
    private readonly config: ScraperConfig,
    private readonly extraDomains: () => readonly string[] = () => [],
    /** How to start Chromium. Tests and unusual installs can supply their own; the default imports Playwright lazily. */
    private readonly launch: () => Promise<Browser> = async () => (await import("playwright")).chromium.launch(),
  ) {}

  /** A page address the crawler may request, redirects included: inside the documentation area, nothing else. */
  private allowPage = (url: string): boolean => {
    const normalized = normalizeUrl(url);
    return normalized !== null && isDocumentationUrl(normalized, this.config);
  };

  /**
   * Which requests a rendered page may make. The page runs its own scripts, so it is limited to the documentation
   * site, approved domains and the user's extra domains (fonts, scripts and APIs on other hosts are refused), and
   * it can never reach localhost or private addresses unless the documentation site itself is there.
   */
  private allowRenderRequest = (url: string, isMainNavigation: boolean): boolean => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol === "data:" || parsed.protocol === "blob:" || url === "about:blank") return true;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    if (isMainNavigation) return this.allowPage(url);
    const host = parsed.hostname.toLowerCase();
    if (parsed.origin === this.config.origin) return true;
    if (isLoopbackHost(host) || isPrivateHost(host)) return false;
    return isDomainApproved(host, this.extraDomains());
  };

  async fetchPage(
    url: string,
    signal?: AbortSignal,
    validators: RequestValidators | null = null,
  ): Promise<FetchedPage> {
    const { renderMode } = this.config;

    if (renderMode === "browser") return this.render(url, signal);

    const page = await withRetries(() => fetchStatic(url, this.config, signal, fetch, validators, { allow: this.allowPage }), {
      maxRetries: this.config.maxRetries,
      backoffMs: this.config.retryBackoffMs,
      signal,
    });

    if (renderMode === "auto" && !page.notModified) {
      const { looksClientRendered } = await import("@/server/scraper/extractor"); // loaded only when needed
      if (looksClientRendered(page.html)) return this.render(url, signal);
    }
    return page;
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    try {
      this.browser = await this.launch();
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
    let page: Page | undefined;
    const context = await browser.newContext({ userAgent: this.config.userAgent, serviceWorkers: "block", acceptDownloads: false });
    try {
      if (!this.allowPage(url)) throw new FetchError("http", `Refused: ${url} is not an allowed documentation address`);
      await context.route("**/*", async (route) => {
        const request = route.request();
        const main = request.isNavigationRequest() && request.frame() === page?.mainFrame();
        if (!this.allowRenderRequest(request.url(), main)) return route.abort("blockedbyclient");
        if (!main) return route.continue();
        // Chromium follows server redirects on its own without asking again, so the page navigation is fetched
        // here with redirects off: a redirect target is checked before the browser is allowed to follow it.
        try {
          const response = await route.fetch({ maxRedirects: 0 });
          const status = response.status();
          if (status >= 300 && status < 400) {
            const location = response.headers()["location"];
            let target: string | null = null;
            try {
              target = location ? new URL(location, request.url()).toString() : null;
            } catch {
              target = null;
            }
            if (target === null || !this.allowRenderRequest(target, true)) return route.abort("blockedbyclient");
          }
          return route.fulfill({ response });
        } catch {
          return route.abort("failed");
        }
      });
      page = await context.newPage();
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
