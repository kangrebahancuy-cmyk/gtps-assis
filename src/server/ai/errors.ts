import type { AiErrorInfo, AiErrorKind, ProviderId } from "@/types/ai";

/** Matches key-shaped strings so they never reach logs, errors or responses. */
const KEY_PATTERNS = [/AIza[0-9A-Za-z_-]{20,}/g, /gsk_[0-9A-Za-z]{16,}/g, /(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi];

/** Removes the exact key (if given) and anything shaped like a provider key. */
export function redactSecrets(text: string, apiKey?: string | null): string {
  let out = text;
  if (apiKey && apiKey.length >= 6) out = out.split(apiKey).join("[redacted]");
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, (_m, prefix?: string) => `${prefix ?? ""}[redacted]`);
  return out;
}

const MAX_MESSAGE = 300;

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly provider: ProviderId | null;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(
    kind: AiErrorKind,
    message: string,
    options: { provider?: ProviderId | null; status?: number | null; retryable?: boolean; retryAfterMs?: number | null; apiKey?: string | null } = {},
  ) {
    const safe = redactSecrets(message, options.apiKey).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
    super(safe);
    this.name = "AiError";
    this.kind = kind;
    this.provider = options.provider ?? null;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  toInfo(): AiErrorInfo {
    return {
      kind: this.kind,
      message: this.message,
      provider: this.provider,
      status: this.status,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
    };
  }
}

/** Turns anything thrown into a safe AiErrorInfo (unknown errors never leak their text). */
export function toErrorInfo(error: unknown, provider: ProviderId | null = null): AiErrorInfo {
  if (error instanceof AiError) return error.provider || !provider ? error.toInfo() : { ...error.toInfo(), provider };
  return { kind: "unknown", message: "Unexpected error.", provider, status: null, retryable: false, retryAfterMs: null };
}

/** Parses "2", "2.5" (seconds) or an HTTP date from a Retry-After header. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

/** Parses durations like "2m59.56s", "7.66s", "1h2m", "250ms", "33s" into milliseconds. */
export function parseDuration(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = /^\s*(?:(\d+(?:\.\d+)?)h)?\s*(?:(\d+(?:\.\d+)?)m(?!s))?\s*(?:(\d+(?:\.\d+)?)s)?\s*(?:(\d+(?:\.\d+)?)ms)?\s*$/.exec(value);
  if (!match || match.slice(1).every((part) => part === undefined)) return null;
  const [h, m, s, ms] = match.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  return Math.round((h ?? 0) * 3_600_000 + (m ?? 0) * 60_000 + (s ?? 0) * 1000 + (ms ?? 0));
}
