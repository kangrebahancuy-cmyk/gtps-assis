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

export async function fetchStatic(
  url: string,
  config: Pick<ScraperConfig, "userAgent" | "timeoutMs">,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
  validators: RequestValidators | null = null,
): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const headers: Record<string, string> = {
    "user-agent": config.userAgent,
    accept: "text/html,application/xhtml+xml",
  };
  if (validators?.etag) headers["if-none-match"] = validators.etag;
  if (validators?.lastModified) headers["if-modified-since"] = validators.lastModified;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers,
      redirect: "follow",
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) throw new FetchError("aborted", "Request cancelled");
    if (timeout.aborted) {
      throw new FetchError("timeout", `Timed out after ${config.timeoutMs} ms`);
    }
    const cause = error instanceof Error ? (error.cause as Error | undefined) : undefined;
    const detail = cause?.message ?? (error instanceof Error ? error.message : String(error));
    throw new FetchError("network", `Network error: ${detail}`);
  }

  if (response.status === 304 && (validators?.etag || validators?.lastModified)) {
    return {
      finalUrl: response.url || url,
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
    html = await response.text();
  } catch {
    throw new FetchError("network", "Connection dropped while reading the response body");
  }
  return {
    finalUrl: response.url || url,
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
