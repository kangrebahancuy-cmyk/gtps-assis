import { AiError, parseDuration } from "@/server/ai/errors";
import { providerFetch, providerJson, type ErrorBodyInfo } from "@/server/ai/http";
import type { AiProvider, ProviderChatRequest, ProviderContext, ProviderStreamEvent } from "@/server/ai/provider";
import { asCount, asString, buildHttp, DEFAULT_STREAM_IDLE_MS, isRecord, looksCodeFocused, parseJson } from "@/server/ai/providers/shared";
import { iterateChunks, parseSse, StreamIdleError } from "@/lib/sse";
import type { AiModel, FinishReason } from "@/types/ai";

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const LABEL = "Google Gemini";
const MAX_PAGES = 10;

/** Google error body: {"error":{"code":429,"message":"...","status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"33s"}]}}. */
export function parseGeminiError(text: string): ErrorBodyInfo {
  const body = parseJson(text);
  const error = isRecord(body) && isRecord(body.error) ? body.error : null;
  if (!error) return { message: text.trim().slice(0, 200) || null, code: null, retryAfterMs: null };
  let retryAfterMs: number | null = null;
  if (Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (isRecord(detail) && typeof detail.retryDelay === "string") retryAfterMs = parseDuration(detail.retryDelay) ?? retryAfterMs;
    }
  }
  const reasons = Array.isArray(error.details)
    ? error.details.flatMap((d) => (isRecord(d) && typeof d.reason === "string" ? [d.reason] : []))
    : [];
  return { message: asString(error.message), code: asString(error.status) ?? reasons[0] ?? null, retryAfterMs };
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "BLOCKLIST":
    case "PROHIBITED_CONTENT":
    case "SPII":
    case "IMAGE_SAFETY":
      return "blocked";
    default:
      return "other";
  }
}

export function toGeminiModel(raw: unknown): AiModel | null {
  if (!isRecord(raw)) return null;
  const resource = asString(raw.name);
  if (!resource) return null;
  const id = resource.replace(/^models\//, "");
  const methods = Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods.filter((m): m is string => typeof m === "string") : [];
  const chat = methods.includes("generateContent") || methods.includes("streamGenerateContent");
  const name = asString(raw.displayName) ?? id;
  return {
    provider: "gemini",
    id,
    name,
    description: asString(raw.description),
    contextWindow: asCount(raw.inputTokenLimit),
    maxOutputTokens: asCount(raw.outputTokenLimit),
    coding: looksCodeFocused(id, name) ? "specialized" : "unknown",
    freeTier: "unverified",
    availability: chat ? "available" : "not_chat",
    availabilityNote: chat ? null : "Does not support generateContent (for example embeddings).",
  };
}

export function createGeminiProvider(baseUrl: string = GEMINI_BASE_URL): AiProvider {
  const headers = (ctx: ProviderContext): Record<string, string> => ({
    // The key goes in a header, never in the URL, so it cannot end up in logs or error messages.
    "x-goog-api-key": ctx.apiKey,
    "content-type": "application/json",
  });

  return {
    id: "gemini",
    label: LABEL,
    docsUrl: "https://ai.google.dev/gemini-api/docs",
    limitsUrl: "https://ai.google.dev/gemini-api/docs/rate-limits",
    quotaNote:
      "The Gemini API does not report remaining quota in its responses. Limits depend on your project and tier; see Google AI Studio for actual usage.",

    async listModels(ctx) {
      const http = buildHttp("gemini", LABEL, ctx, parseGeminiError);
      const models: AiModel[] = [];
      let pageToken: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const url = `${baseUrl}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const body = await providerJson<unknown>(http, url, { method: "GET", headers: headers(ctx) }, ctx.signal);
        if (!isRecord(body)) throw new AiError("provider_unavailable", `${LABEL} returned an unexpected model list.`, { provider: "gemini", retryable: true });
        for (const raw of Array.isArray(body.models) ? body.models : []) {
          const model = toGeminiModel(raw);
          if (model) models.push(model);
        }
        pageToken = asString(body.nextPageToken);
        if (!pageToken) break;
      }
      return models;
    },

    async *streamChat(ctx, request: ProviderChatRequest): AsyncGenerator<ProviderStreamEvent> {
      const http = buildHttp("gemini", LABEL, ctx, parseGeminiError);
      const system = request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const body = {
        contents: request.messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
          ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        },
      };
      const url = `${baseUrl}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`;
      const { response, abort } = await providerFetch(http, url, { method: "POST", headers: headers(ctx), body: JSON.stringify(body) }, ctx.signal);
      if (!response.body) throw new AiError("provider_unavailable", `${LABEL} sent an empty stream.`, { provider: "gemini", retryable: true });

      let finish: FinishReason | null = null;
      let usage: { input: number | null; output: number | null; total: number | null } | null = null;
      try {
        const chunks = iterateChunks(response.body, { idleMs: ctx.streamIdleMs ?? DEFAULT_STREAM_IDLE_MS, signal: ctx.signal });
        for await (const message of parseSse(chunks)) {
          const chunk = parseJson(message.data);
          if (!isRecord(chunk)) continue;

          if (isRecord(chunk.error)) {
            const info = parseGeminiError(message.data);
            throw new AiError("provider_unavailable", `${LABEL} stream error${info.message ? `: ${info.message}` : ""}`, { provider: "gemini", retryable: true, apiKey: ctx.apiKey });
          }
          if (isRecord(chunk.promptFeedback) && typeof chunk.promptFeedback.blockReason === "string") {
            throw new AiError("content_blocked", `${LABEL} blocked the prompt (${chunk.promptFeedback.blockReason}).`, { provider: "gemini" });
          }
          if (isRecord(chunk.usageMetadata)) {
            // Cumulative in every chunk: keep the latest.
            usage = {
              input: asCount(chunk.usageMetadata.promptTokenCount),
              output: asCount(chunk.usageMetadata.candidatesTokenCount),
              total: asCount(chunk.usageMetadata.totalTokenCount),
            };
          }
          const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined;
          if (!isRecord(candidate)) continue;

          const parts = isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
          for (const part of parts) {
            // Skip reasoning ("thought") parts and parts without text (e.g. signatures).
            if (isRecord(part) && part.thought !== true && typeof part.text === "string" && part.text !== "") {
              yield { type: "delta", text: part.text };
            }
          }
          if (typeof candidate.finishReason === "string" && candidate.finishReason !== "" && candidate.finishReason !== "FINISH_REASON_UNSPECIFIED") {
            finish = mapFinish(candidate.finishReason);
          }
        }
      } catch (error) {
        if (error instanceof AiError) throw error;
        if (ctx.signal?.aborted) throw new AiError("cancelled", "The request was cancelled.", { provider: "gemini" });
        if (error instanceof StreamIdleError) throw new AiError("timeout", `${LABEL} stopped sending data.`, { provider: "gemini", retryable: true });
        throw new AiError("network", `The connection to ${LABEL} was interrupted.`, { provider: "gemini", retryable: true });
      } finally {
        abort();
      }

      if (finish === null) throw new AiError("provider_unavailable", `${LABEL} ended the stream without finishing.`, { provider: "gemini", retryable: true });
      if (usage) yield { type: "usage", inputTokens: usage.input, outputTokens: usage.output, totalTokens: usage.total };
      yield { type: "done", finishReason: finish };
    },
  };
}
