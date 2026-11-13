import { AiError } from "@/server/ai/errors";
import { providerFetch, providerJson, type ErrorBodyInfo } from "@/server/ai/http";
import type { AiProvider, ProviderChatRequest, ProviderStreamEvent } from "@/server/ai/provider";
import { asCount, asString, buildHttp, DEFAULT_STREAM_IDLE_MS, isRecord, looksCodeFocused, parseJson } from "@/server/ai/providers/shared";
import { iterateChunks, parseSse, StreamIdleError } from "@/lib/sse";
import type { AiModel, FinishReason } from "@/types/ai";

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const LABEL = "Groq";

/** Models that do not generate chat text. Groq's model list has no type field, so this is a guess from the id. */
const NON_CHAT_ID = /(whisper|tts|speech|transcri|orpheus|playai|embed|guard|moderation|safeguard)/i;

/** OpenAI-style error body: {"error":{"message":"...","type":"...","code":"..."}}. */
export function parseGroqError(text: string): ErrorBodyInfo {
  const body = parseJson(text);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (!error) return { message: text.trim().slice(0, 200) || null, code: null, retryAfterMs: null };
  return { message: asString(error.message), code: asString(error.code) ?? asString(error.type), retryAfterMs: null };
}

function mapFinish(reason: string): FinishReason {
  if (reason === "stop") return "stop";
  if (reason === "length") return "length";
  if (reason === "content_filter") return "blocked";
  return "other";
}

export function toGroqModel(raw: unknown): AiModel | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  const nonChat = NON_CHAT_ID.test(id);
  const inactive = raw.active === false;
  const owner = asString(raw.owned_by);
  return {
    provider: "groq",
    id,
    name: id,
    description: owner ? `Provided by ${owner}` : null,
    contextWindow: asCount(raw.context_window),
    maxOutputTokens: asCount(raw.max_completion_tokens),
    coding: looksCodeFocused(id) ? "specialized" : "unknown",
    freeTier: "unverified",
    availability: inactive ? "inactive" : nonChat ? "not_chat" : "available",
    availabilityNote: inactive
      ? "Groq lists this model as inactive."
      : nonChat
        ? "Looks like a speech, embedding or safety model (guessed from its id; Groq does not report a model type)."
        : null,
  };
}

export function createGroqProvider(baseUrl: string = GROQ_BASE_URL): AiProvider {
  return {
    id: "groq",
    label: LABEL,
    docsUrl: "https://console.groq.com/docs",
    limitsUrl: "https://console.groq.com/docs/rate-limits",
    quotaNote:
      "Groq reports your request/token limits and what remains in x-ratelimit-* response headers. Those are shown after a request; the free-tier eligibility of each model is not exposed by the API.",

    async listModels(ctx) {
      const http = buildHttp("groq", LABEL, ctx, parseGroqError);
      const body = await providerJson<unknown>(
        http,
        `${baseUrl}/models`,
        { method: "GET", headers: { authorization: `Bearer ${ctx.apiKey}` } },
        ctx.signal,
      );
      const list = isRecord(body) && Array.isArray(body.data) ? body.data : null;
      if (!list) throw new AiError("provider_unavailable", `${LABEL} returned an unexpected model list.`, { provider: "groq", retryable: true });
      return list.flatMap((raw) => {
        const model = toGroqModel(raw);
        return model ? [model] : [];
      });
    },

    async *streamChat(ctx, request: ProviderChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const http = buildHttp("groq", LABEL, ctx, parseGroqError);
      const body = {
        model: request.model,
        messages: request.messages,
        stream: true,
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxOutputTokens !== undefined ? { max_completion_tokens: request.maxOutputTokens } : {}),
      };
      const { response, abort } = await providerFetch(
        http,
        `${baseUrl}/chat/completions`,
        { method: "POST", headers: { authorization: `Bearer ${ctx.apiKey}`, "content-type": "application/json" }, body: JSON.stringify(body) },
        ctx.signal,
      );
      if (!response.body) throw new AiError("provider_unavailable", `${LABEL} sent an empty stream.`, { provider: "groq", retryable: true });

      let finish: FinishReason | null = null;
      let usage: { input: number | null; output: number | null; total: number | null } | null = null;
      let sawDone = false;
      try {
        const chunks = iterateChunks(response.body, { idleMs: ctx.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS, signal: ctx.signal });
        for await (const message of parseSse(chunks)) {
          if (message.data.trim() === "[DONE]") {
            sawDone = true;
            break;
          }
          const chunk = parseJson(message.data);
          if (!isRecord(chunk)) continue;
          if (isRecord(chunk.error)) {
            const info = parseGroqError(message.data);
            throw new AiError("provider_unavailable", `${LABEL} stream error${info.message ? `: ${info.message}` : ""}`, { provider: "groq", retryable: true, apiKey: ctx.apiKey });
          }
          const usageBlock = isRecord(chunk.usage) ? chunk.usage : isRecord(chunk.x_groq) && isRecord(chunk.x_groq.usage) ? chunk.x_groq.usage : null;
          if (usageBlock) {
            usage = { input: asCount(usageBlock.prompt_tokens), output: asCount(usageBlock.completion_tokens), total: asCount(usageBlock.total_tokens) };
          }
          const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
          if (!isRecord(choice)) continue;
          if (isRecord(choice.delta) && typeof choice.delta.content === "string" && choice.delta.content !== "") {
            yield { type: "delta", text: choice.delta.content };
          }
          if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") finish = mapFinish(choice.finish_reason);
        }
      } catch (error) {
        if (error instanceof AiError) throw error;
        if (ctx.signal?.aborted) throw new AiError("cancelled", "The request was cancelled.", { provider: "groq" });
        if (error instanceof StreamIdleError) throw new AiError("timeout", `${LABEL} stopped sending data.`, { provider: "groq", retryable: true });
        throw new AiError("network", `The connection to ${LABEL} was interrupted.`, { provider: "groq", retryable: true });
      } finally {
        abort();
      }

      if (finish === null && !sawDone) throw new AiError("provider_unavailable", `${LABEL} ended the stream without finishing.`, { provider: "groq", retryable: true });
      if (usage) yield { type: "usage", inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total };
      yield { type: "done", finishReason: finish ?? "stop" };
    },
  };
}
