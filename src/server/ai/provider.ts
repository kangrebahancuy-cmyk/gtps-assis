import type { Sleep } from "@/server/ai/http";
import type { AiModel, ChatMessage, FinishReason, ProviderId, RateLimitSnapshot } from "@/types/ai";

/** A chat request with defaults resolved: this is what adapters receive. */
export interface ProviderChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

/** What adapters emit while streaming; the service adds the `start` event. */
export type ProviderStreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }
  | { type: "done"; finishReason: FinishReason };

export interface ProviderContext {
  apiKey: string;
  fetch: typeof fetch;
  sleep: Sleep;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Idle time allowed between streamed chunks. */
  streamIdleMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  retryBackoffMs?: number;
  onRateLimit?: (snapshot: RateLimitSnapshot) => void;
}

/**
 * The only thing the rest of the app knows about a provider. Adding a provider
 * means implementing this interface and registering it; chat code never changes.
 */
export interface AiProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly docsUrl: string;
  readonly limitsUrl: string;
  /** What this provider tells us (and does not tell us) about remaining quota. */
  readonly quotaNote: string;
  listModels(ctx: ProviderContext): Promise<AiModel[]>;
  streamChat(ctx: ProviderContext, request: ProviderChatRequest): AsyncGenerator<ProviderStreamEvent>;
}
