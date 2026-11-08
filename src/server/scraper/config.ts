export type RenderMode = "static" | "auto" | "browser";

export interface ScraperConfig {
  /** First page to crawl. */
  startUrl: string;
  /** Only URLs on this origin are crawled. */
  origin: string;
  /** Only paths equal to or below this prefix are crawled. */
  pathPrefix: string;
  userAgent: string;
  /** Minimum delay between two requests (raised by robots.txt Crawl-delay). */
  requestDelayMs: number;
  timeoutMs: number;
  /** Extra attempts for network errors, timeouts, 429 and 5xx. */
  maxRetries: number;
  retryBackoffMs: number;
  /** Safety cap on pages processed per run. */
  maxPages: number;
  /**
   * static  - plain HTTP fetch only.
   * auto    - plain fetch, Playwright only when a page looks client-rendered.
   * browser - always render with Playwright.
   */
  renderMode: RenderMode;
  /** Pages whose cleaned text is shorter than this are treated as empty. */
  minContentLength: number;
}

export const DEFAULT_START_URL = "https://dash.gtps.cloud/docs";

export const DEFAULT_USER_AGENT =
  "GTPSAssistantBot/0.1 (+https://github.com/kangrebahancuy-cmyk/gtps-assis)";

export function createConfig(
  overrides: Partial<ScraperConfig> = {},
): ScraperConfig {
  const startUrl = overrides.startUrl ?? DEFAULT_START_URL;
  const parsed = new URL(startUrl);
  return {
    startUrl,
    origin: parsed.origin,
    pathPrefix: parsed.pathname.replace(/\/+$/, "") || "/",
    userAgent: DEFAULT_USER_AGENT,
    requestDelayMs: 1000,
    timeoutMs: 20_000,
    maxRetries: 2,
    retryBackoffMs: 1500,
    maxPages: 500,
    renderMode: "auto",
    minContentLength: 20,
    ...overrides,
  };
}

/** Where the SQLite database lives. Override with GTPS_DB_PATH. */
export function getDatabasePath(): string {
  return process.env.GTPS_DB_PATH ?? "data/gtps-assistant.db";
}
