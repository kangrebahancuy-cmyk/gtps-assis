/**
 * Shared AI types. Nothing here ever carries an API key out of the server:
 * responses expose only whether a key is configured and its last characters.
 */

export const PROVIDER_IDS = ["gemini", "groq"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const isProviderId = (value: unknown): value is ProviderId =>
  typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);

export type AiErrorKind =
  | "not_configured"
  | "invalid_key"
  | "permission_denied"
  | "rate_limited"
  | "model_not_found"
  | "bad_request"
  | "content_blocked"
  | "provider_unavailable"
  | "network"
  | "timeout"
  | "cancelled"
  | "invalid_input"
  | "unknown";

/** A provider/network/input error that is safe to show: it never contains a key. */
export interface AiErrorInfo {
  kind: AiErrorKind;
  message: string;
  provider: ProviderId | null;
  /** HTTP status from the provider, when there was one. */
  status: number | null;
  /** Whether trying again later can help (rate limit, outage, network). */
  retryable: boolean;
  /** How long the provider asked us to wait, when it said. */
  retryAfterMs: number | null;
}

// ---- models ----------------------------------------------------------------

/** "specialized": the model id/name says it is code-focused. Providers do not publish a coding score. */
export type CodingCapability = "specialized" | "unknown";

/**
 * Whether a model is on the provider's free tier. Neither provider exposes this
 * through its API, so everything is "unverified" unless a verified source is added.
 * This is eligibility, never remaining quota.
 */
export type FreeTierStatus = "verified_free" | "verified_not_free" | "unverified";

/**
 * available: the provider lists it and it can generate text.
 * inactive:  the provider lists it but marks it inactive.
 * not_chat:  it does not generate chat text (embedding, speech, guard...).
 */
export type ModelAvailability = "available" | "inactive" | "not_chat";

export interface AiModel {
  provider: ProviderId;
  /** The id to send back to the provider. */
  id: string;
  name: string;
  description: string | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  coding: CodingCapability;
  freeTier: FreeTierStatus;
  availability: ModelAvailability;
  /** Why `availability` is not "available", when the reason is a guess from the model id. */
  availabilityNote: string | null;
}

export interface ModelCatalog {
  provider: ProviderId;
  models: AiModel[];
  fetchedAt: string;
  /** True when this is an older list shown because the latest refresh failed. */
  stale: boolean;
  error: AiErrorInfo | null;
}

// ---- status / settings ------------------------------------------------------

export interface QuotaWindow {
  limit: number | null;
  remaining: number | null;
  /** Provider's own text, e.g. "2m59.56s". */
  resetsIn: string | null;
}

/** Quota as reported by the provider in its last response headers. Not a prediction. */
export interface RateLimitSnapshot {
  observedAt: string;
  requests: QuotaWindow | null;
  tokens: QuotaWindow | null;
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string;
  configured: boolean;
  keySource: "saved" | "environment" | null;
  /** Last characters of the key, e.g. "…a1b2". Never the key. */
  keyHint: string | null;
  /** While set and in the future, chat requests are refused locally after a rate-limit response. */
  cooldownUntil: string | null;
  rateLimit: RateLimitSnapshot | null;
  modelsFetchedAt: string | null;
  modelCount: number | null;
  docsUrl: string;
  limitsUrl: string;
  /** What this provider does and does not tell us about remaining quota. */
  quotaNote: string;
}

export interface AiDefaults {
  provider: ProviderId | null;
  model: string | null;
}

export interface AiSettingsView {
  providers: ProviderStatus[];
  defaults: AiDefaults;
  /**
   * Whether the default model is in the provider's latest model list:
   * null when that list has not been loaded, false when the model has disappeared (deprecated or renamed).
   */
  defaultModelListed: boolean | null;
}

export interface ConnectionTestResult {
  provider: ProviderId;
  /** What was checked: "key" lists models; "model" also runs a tiny generation. */
  scope: "key" | "model";
  ok: boolean;
  latencyMs: number | null;
  modelCount: number | null;
  testedModel: string | null;
  error: AiErrorInfo | null;
}

// ---- chat -------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Provider and model are optional: the saved defaults apply when omitted. */
export interface ChatRequest {
  provider?: ProviderId;
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export type FinishReason = "stop" | "length" | "blocked" | "other";

export type ChatStreamEvent =
  | { type: "start"; provider: ProviderId; model: string }
  | { type: "delta"; text: string }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
  | { type: "done"; finishReason: FinishReason }
  | { type: "error"; error: AiErrorInfo };
