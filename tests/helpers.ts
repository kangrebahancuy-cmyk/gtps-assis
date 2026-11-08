import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { createConfig, type ScraperConfig } from "@/server/scraper/config";
import type { ExtractedPage } from "@/server/scraper/extractor";
import {
  FetchError,
  type FetchedPage,
  type PageFetcher,
  type RequestValidators,
} from "@/server/scraper/fetcher";
import { sha256 } from "@/server/scraper/hash";
import { resolveDocLink } from "@/server/scraper/url";

export const BASE = "https://docs.example.test";

export function testConfig(overrides: Partial<ScraperConfig> = {}): ScraperConfig {
  return createConfig({
    startUrl: `${BASE}/docs`,
    requestDelayMs: 0,
    maxRetries: 0,
    minContentLength: 5,
    ...overrides,
  });
}

export function freshRepo(): { repo: Repository } {
  return { repo: new Repository(openDatabase(":memory:")) };
}

/** Fake page body understood by `fakeExtract` (no HTML parser needed). */
export interface FakeBody {
  title: string;
  text: string;
  links?: string[];
  code?: string[];
}

export const body = (b: FakeBody): string => JSON.stringify(b);

export function fakeExtract(
  html: string,
  url: string,
  config: ScraperConfig,
): ExtractedPage {
  const b = JSON.parse(html) as FakeBody;
  const text = b.text.trim();
  return {
    url,
    title: b.title,
    category: null,
    rawContent: html,
    cleanedContent: text,
    contentHash: sha256(text),
    headings: [{ level: 1, text: b.title }],
    sections: [{ heading: b.title, level: 1, position: 0, content: text }],
    tables: [],
    codeExamples: (b.code ?? []).map((code) => ({ language: "lua", code, context: b.title })),
    apiEntries: [],
    links: [],
    docLinks: (b.links ?? [])
      .map((href) => resolveDocLink(href, url, config))
      .filter((u): u is string => u !== null),
  };
}

export type Route =
  | { html: string; etag?: string }
  | { error: FetchError }
  | { redirectTo: string; html: string };

/**
 * In-memory site. Unknown URLs behave like HTTP 404. Tests may mutate `routes`
 * between runs to simulate edits, deletions and outages. Honours ETag
 * validators like a real server (answers 304 when they match).
 */
export class FakeFetcher implements PageFetcher {
  readonly requested: string[] = [];
  /** Validators sent with each request, in order (null = unconditional). */
  readonly sentValidators: Array<{ url: string; validators: RequestValidators | null }> = [];

  constructor(
    public routes: Record<string, Route>,
    private readonly onFetch?: (url: string) => void,
  ) {}

  async fetchPage(
    url: string,
    _signal?: AbortSignal,
    validators: RequestValidators | null = null,
  ): Promise<FetchedPage> {
    this.requested.push(url);
    this.sentValidators.push({ url, validators });
    this.onFetch?.(url);
    const route = this.routes[url];
    if (!route) throw new FetchError("http", "HTTP 404 Not Found", 404);
    if ("error" in route) throw route.error;
    if ("etag" in route && route.etag && validators?.etag === route.etag) {
      return { finalUrl: url, html: "", httpStatus: 304, rendered: "static", etag: route.etag, notModified: true };
    }
    return {
      finalUrl: "redirectTo" in route ? route.redirectTo : url,
      html: route.html,
      httpStatus: 200,
      rendered: "static",
      etag: "etag" in route ? route.etag ?? null : null,
    };
  }

  async close(): Promise<void> {}

  reset(): void {
    this.requested.length = 0;
    this.sentValidators.length = 0;
  }
}
