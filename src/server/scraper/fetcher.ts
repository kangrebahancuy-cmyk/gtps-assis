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

export interface FetchedPage {
  /** Final URL after redirects. */
  finalUrl: string;
  html: string;
  httpStatus: number;
  rendered: "static" | "browser";
}

/** A page source. Tests substitute their own implementation. */
export interface PageFetcher {
  fetchPage(url: string, signal?: AbortSignal): Promise<FetchedPage>;
  close(): Promise<void>;
}

type FetchFn = typeof fetch;

export async function fetchStatic(
  url: string,
  config: Pick<ScraperConfig, "userAgent" | "timeoutMs">,
  signal?: AbortSignal,
  fetchFn: FetchFn = fetch,
): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        "user-agent": config.userAgent,
        accept: "text/html,application/xhtml+xml",
      },
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
  return { finalUrl: response.url || url, html, httpStatus: response.status, rendered: "static" };
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
