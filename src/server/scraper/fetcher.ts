import type { ScraperConfig } from "@/server/scraper/config";
import { defaultSleep, type Sleep } from "@/server/scraper/rate-limiter";

export type FetchErrorKind =
  | "network"
  | "timeout"
  | "http"
  | "not-html"
  | "browser"
  | "aborted";

export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
    this.name = "FetchError";
  }

  /** Whether trying again could plausibly succeed. */
  get retryable(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    if (this.kind === "http") {
      return this.httpStatus === 429 || (this.httpStatus ?? 0) >= 500;
    }
    return false;
  }
}

/** Cache validators sent back to the server so it can answer 304 Not Modified. */
export interface RequestValidators {
  etag: string | null;
  lastModified: string | null;
}

export interface FetchedPage {
  /** Final URL after redirects. */
  finalUrl: string;
  /** Empty when notModified is true. */
  html: string;
  httpStatus: number;
  rendered: "static" | "browser";
  /** Validators the server returned, saved for the next incremental sync. */
  etag?: string | null;
  lastModified?: string | null;
  /** The server answered 304: the stored copy is still current. */
  notModified?: boolean;
}

/** A page source. Tests substitute their own implementation. */
export interface PageFetcher {
  fetchPage(
    url: string,
    signal?: AbortSignal,
    validators?: RequestValidators | null,
  ): Promise<FetchedPage>;
  close(): Promise<void>;
}

type FetchFn = typeof fetch;

/** The most redirects followed for one page. */
export const MAX_REDIRECTS = 5;
/** The largest page body read into memory (the real documentation pages are a few hundred KB at most). */
export const DEFAULT_MAX_PAGE_BYTES = 5 * 1024 * 1024;

export interface FetchGuard {
  /**
   * Called with every URL BEFORE it is requested, including each redirect target. Return false to refuse it.
   * This is what keeps a redirect on an approved site from sending the crawler to localhost, a private
   * network address or any other site.
   */
  allow?: (url: string) => boolean;
  /** Longest body accepted. */
  maxBytes?: number;
}

/**
 * Reads a response body but stops (and drops the connection) once it is larger than `maxBytes`, so one huge or endless
 * response cannot exhaust memory.
 */
export async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new FetchError("not-html", `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB and was not read`);
  }
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchError("not-html", `The page is larger than ${Math.round(maxBytes / 1024 / 1024)} MB and was not read`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function fetchStatic(
  url: string,
  config: Pick<ScraperConfig, "userAgent" | "timeoutMs">,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
  validators: RequestValidators | null = null,
  guard: FetchGuard = {},
): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const headers: Record<string, string> = {
    "user-agent": config.userAgent,
    accept: "text/html,application/xhtml+xml",
  };
  if (validators?.etag) headers["if-none-match"] = validators.etag;
  if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;

  // Redirects are followed by hand so that every hop is checked before it is requested.
  let current = url;
  let response: Response;
  for (let hop = 0; ; hop += 1) {
    if (guard.allow && !guard.allow(current)) {
      throw new FetchError("http", hop === 0 ? `Refused: ${current} is not an allowed documentation address` : `Redirected outside documentation area: ${current} (not followed)`);
    }
    try {
      response = await fetchFn(current, { headers, redirect: "manual", signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new FetchError("aborted", "Request cancelled");
      if (timeout.aborted) {
        throw new FetchError("timeout", `Timed out after ${config.timeoutMs} ms`);
      }
      const cause = error instanceof Error ? (error.cause as Error | undefined) : undefined;
      const detail = cause?.message ?? (error instanceof Error ? error.message : String(error));
      throw new FetchError("network", `Network error: ${detail}`);
    }
    const isRedirect = response.status >= 300 && response.status < 400 && response.status !== 304;
    if (!isRedirect) break;
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => undefined);
    if (!location) throw new FetchError("http", `HTTP ${response.status} without a Location header`, response.status);
    if (hop >= MAX_REDIRECTS) throw new FetchError("http", `Too many redirects (more than ${MAX_REDIRECTS})`);
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new FetchError("http", "Redirect to an invalid address");
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") throw new FetchError("http", `Redirect to a ${next.protocol} address was refused`);
    current = next.toString();
  }

  if (response.status === 304 && (validators?.etag || validators?.lastModified)) {
    return {
      finalUrl: response.url || current,
      html: "",
      httpStatus: 304,
      rendered: "static",
      etag: validators.etag,
      lastModified: validators.lastModified,
      notModified: true,
    };
  }
  if (!response.ok) {
    throw new FetchError("http", `HTTP ${response.status} ${response.statusText}`.trim(), response.status);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type && !/html|xml/i.test(type)) {
    throw new FetchError("not-html", `Unexpected content type: ${type}`, response.status);
  }

  let html: string;
  try {
    html = await readBodyCapped(response, guard.maxBytes ?? DEFAULT_MAX_PAGE_BYTES);
  } catch (error) {
    if (error instanceof FetchError) throw error;
    throw new FetchError("network", "Connection dropped while reading the response body");
  }
  return {
    finalUrl: response.url || current,
    html,
    httpStatus: response.status,
    rendered: "static",
    etag: response.headers.get("etag"),
    lastModified: response.headers.get("last-modified"),
  };
}

/** Retries retryable failures with linear backoff. Never retries a cancel. */
export async function withRetries<T>(
  task: () => Promise<T>,
  options: {
    maxRetries: number;
    backoffMs: number;
    signal?: AbortSignal;
    sleep?: Sleep;
    onRetry?: (error: FetchError, attempt: number) => void;
  },
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (!(error instanceof FetchError) || !error.retryable || attempt >= options.maxRetries) {
        throw error;
      }
      if (options.signal?.aborted) throw new FetchError("aborted", "Request cancelled");
      options.onRetry?.(error, attempt + 1);
      await sleep(options.backoffMs * (attempt + 1), options.signal);
    }
  }
}
