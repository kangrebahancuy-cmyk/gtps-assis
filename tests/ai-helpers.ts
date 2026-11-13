import type { ProviderContext, ProviderStreamEvent, AiProvider, ProviderChatRequest } from "@/server/ai/provider";
import type { RateLimitSnapshot } from "@/types/ai";

export interface Rig {
  ctx: ProviderContext;
  sleeps: number[];
  rateLimits: RateLimitSnapshot[];
}

/** Real fetch, no real waiting: sleeps are recorded instead of performed. */
export function rig(apiKey: string, overrides: Partial<ProviderContext> = {}): Rig {
  const sleeps: number[] = [];
  const rateLimits: RateLimitSnapshot[] = [];
  return {
    sleeps,
    rateLimits,
    ctx: {
      apiKey,
      fetch,
      sleep: async (ms) => void sleeps.push(ms),
      timeoutMs: 2000,
      streamIdleMs: 2000,
      maxRetries: 2,
      maxRetryWaitMs: 10_000,
      retryBackoffMs: 100,
      onRateLimit: (s) => void rateLimits.push(s),
      ...overrides,
    },
  };
}

export async function collect(provider: AiProvider, ctx: ProviderContext, request: Partial<ProviderChatRequest> = {}): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of provider.streamChat(ctx, { model: "m", messages: [{ role: "user", content: "hi" }], ...request })) events.push(event);
  return events;
}

export const textOf = (events: ProviderStreamEvent[]): string => events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
