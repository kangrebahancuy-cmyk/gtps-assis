import { readRateLimitHeaders, type ErrorBodyInfo, type ProviderHttp } from "@/server/ai/http";
import type { ProviderContext } from "@/server/ai/provider";
import type { ProviderId } from "@/types/ai";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_STREAM_IDLE_MS = 60_000;

export function buildHttp(
  provider: ProviderId,
  label: string,
  ctx: ProviderContext,
  parseErrorBody: (text: string) => ErrorBodyInfo,
): ProviderHttp {
  return {
    provider,
    label,
    apiKey: ctx.apiKey,
    fetch: ctx.fetch,
    timeoutMs: ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxRetries: ctx.maxRetries ?? 2,
    maxRetryWaitMs: ctx.maxRetryWaitMs ?? 10_000,
    retryBackoffMs: ctx.retryBackoffMs ?? 500,
    sleep: ctx.sleep,
    parseErrorBody,
    onHeaders: (headers) => {
      const snapshot = readRateLimitHeaders(headers);
      if (snapshot) ctx.onRateLimit?.(snapshot);
    },
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const asString = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

export const asCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Ids that suggest a code-focused model. A name heuristic: providers publish no coding score. */
export const looksCodeFocused = (...names: Array<string | null | undefined>): boolean =>
  names.some((n) => n !== null && n !== undefined && /(^|[-_/ .])(coder?|codestral|codegemma|devstral)([-_/ .:0-9]|$)/i.test(n));
