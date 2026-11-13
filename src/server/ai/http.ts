import { AiError, parseDuration, parseRetryAfter } from "@/server/ai/errors";
import type { ProviderId, QuotaWindow, RateLimitSnapshot } from "@/types/ai";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** What a provider's error body told us, in provider-independent terms. */
export interface ErrorBodyInfo {
  message: string | null;
  /** Provider-specific machine code/status, e.g. "RESOURCE_EXHAUSTED". */
  code: string | null;
  retryAfterMs: number | null;
}

export interface ProviderHttp {
  provider: ProviderId;
  label: string;
  apiKey: string;
  fetch: typeof fetch;
  /** Time allowed until response headers arrive (and for non-streaming bodies). */
  timeoutMs: number;
  /** Extra attempts after the first for 429/5xx/network errors. */
  maxRetries: number;
  /** Longest wait we accept before a retry; a longer Retry-After is reported instead of waited. */
  maxRetryWaitMs: number;
  retryBackoffMs: number;
  sleep: Sleep;
  parseErrorBody: (text: string) => ErrorBodyInfo;
  /** Called with the headers of every response, successful or not. */
  onHeaders?: (headers: Headers) => void;
}

const KEY_REJECTED = /api[ _-]?key (?:not valid|is invalid|invalid|expired)|API_KEY_INVALID|invalid api key|incorrect api key/i;

/** Maps an HTTP failure to a safe, typed error. */
export function classifyHttpError(http: ProviderHttp, status: number, body: ErrorBodyInfo, headers: Headers): AiError {
  const detail = body.message ? `: ${body.message}` : "";
  const retryAfterMs = parseRetryAfter(headers.get("retry-after")) ?? body.retryAfterMs;
  const base = { provider: http.provider, status, apiKey: http.apiKey, retryAfterMs };

  if (status === 401 || (status === 400 && (KEY_REJECTED.test(body.message ?? "") || KEY_REJECTED.test(body.code ?? "")))) {
    return new AiError("invalid_key", `${http.label} rejected the API key${detail}`, base);
  }
  if (status === 403) return new AiError("permission_denied", `${http.label} denied access${detail}`, base);
  if (status === 404) return new AiError("model_not_found", `${http.label} could not find the requested model or resource${detail}`, base);
  if (status === 408) return new AiError("timeout", `${http.label} timed out${detail}`, { ...base, retryable: true });
  if (status === 429) {
    return new AiError("rate_limited", `${http.label} rate limit reached${detail}`, { ...base, retryable: true });
  }
  if (status >= 500) {
    return new AiError("provider_unavailable", `${http.label} is unavailable (HTTP ${status})${detail}`, { ...base, retryable: true });
  }
  if (status >= 400) return new AiError("bad_request", `${http.label} rejected the request${detail}`, base);
  return new AiError("unknown", `${http.label} returned HTTP ${status}${detail}`, base);
}

export interface ProviderResponse {
  response: Response;
  /** Aborts the request (and a streaming body still being read). */
  abort: () => void;
}

/**
 * fetch with a header timeout, cancellation, safe error mapping and retries
 * for rate limits, server errors and network failures. The key only ever
 * travels in `init.headers` and is redacted from every error.
 */
export async function providerFetch(
  http: ProviderHttp,
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<ProviderResponse> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new AiError("cancelled", "The request was cancelled.", { provider: http.provider });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, http.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let failure: AiError | null = null;
    try {
      const response = await http.fetch(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      http.onHeaders?.(response.headers);
      if (response.ok) return { response, abort: () => controller.abort() };

      const text = (await response.text().catch(() => "")).slice(0, 8192);
      failure = classifyHttpError(http, response.status, http.parseErrorBody(text), response.headers);
    } catch {
      clearTimeout(timer);
      if (signal?.aborted) throw new AiError("cancelled", "The request was cancelled.", { provider: http.provider });
      failure = timedOut
        ? new AiError("timeout", `${http.label} did not respond within ${Math.round(http.timeoutMs / 1000)} s.`, { provider: http.provider, retryable: true })
        : new AiError("network", `Could not reach ${http.label}. Check your internet connection.`, { provider: http.provider, retryable: true, apiKey: http.apiKey });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!failure.retryable || attempt >= http.maxRetries) throw failure;
    const wait = failure.retryAfterMs ?? http.retryBackoffMs * 2 ** attempt;
    if (wait > http.maxRetryWaitMs) throw failure; // report it; do not sit and wait
    try {
      await http.sleep(wait, signal);
    } catch {
      throw new AiError("cancelled", "The request was cancelled.", { provider: http.provider });
    }
  }
}

/** providerFetch + JSON body, with the timeout also covering the body read. */
export async function providerJson<T>(http: ProviderHttp, url: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
  const { response, abort } = await providerFetch(http, url, init, signal);
  const timer = setTimeout(abort, http.timeoutMs);
  try {
    return (await response.json()) as T;
  } catch {
    if (signal?.aborted) throw new AiError("cancelled", "The request was cancelled.", { provider: http.provider });
    throw new AiError("provider_unavailable", `${http.label} returned an unreadable response.`, { provider: http.provider, retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

// ---- rate-limit headers -----------------------------------------------------

const toInt = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function window(headers: Headers, kind: "requests" | "tokens"): QuotaWindow | null {
  const limit = toInt(headers.get(`x-ratelimit-limit-${kind}`));
  const remaining = toInt(headers.get(`x-ratelimit-remaining-${kind}`));
  const resetsIn = headers.get(`x-ratelimit-reset-${kind}`);
  return limit === null && remaining === null && resetsIn === null ? null : { limit, remaining, resetsIn };
}

/** Quota exactly as reported in x-ratelimit-* headers; null when the provider sends none. */
export function readRateLimitHeaders(headers: Headers, now = new Date()): RateLimitSnapshot | null {
  const requests = window(headers, "requests");
  const tokens = window(headers, "tokens");
  return requests || tokens ? { observedAt: now.toISOString(), requests, tokens } : null;
}

/** Longest reset time announced in rate-limit headers, in ms (for cooldowns). */
export function resetDelayMs(snapshot: RateLimitSnapshot | null): number | null {
  const values = [snapshot?.requests?.resetsIn, snapshot?.tokens?.resetsIn].map((v) => parseDuration(v ?? null)).filter((v): v is number => v !== null);
  return values.length > 0 ? Math.max(...values) : null;
}
