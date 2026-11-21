import { iterateChunks, parseSse, StreamIdleError } from "@/lib/sse";
import {
  PROVIDER_IDS,
  type AiErrorInfo,
  type AiErrorKind,
  type AiSettingsView,
  type ChatRequest,
  type ChatStreamEvent,
  type ConnectionTestResult,
  type ModelCatalog,
  type ProviderId,
} from "@/types/ai";
import type { ScriptCheck } from "@/types/lua";

/**
 * Browser-side client for the local /api/ai/* backend. It never sees a provider
 * key coming back (the server only returns hints); keys only travel from the
 * form to the local backend when the user saves or tests them.
 *
 * The chat UI should call `streamChat` and nothing else: which provider and
 * model answer is decided by the saved defaults or by the request's optional
 * `provider`/`model`, so switching providers needs no UI change.
 */

export class AiClientError extends Error {
  constructor(readonly info: AiErrorInfo) {
    super(info.message);
    this.name = "AiClientError";
  }
}

const info = (kind: AiErrorKind, message: string, status: number | null = null, retryable = false): AiErrorInfo => ({
  kind,
  message,
  provider: null,
  status,
  retryable,
  retryAfterMs: null,
});

const KINDS: readonly string[] = [
  "not_configured", "invalid_key", "permission_denied", "rate_limited", "model_not_found", "bad_request", "content_blocked",
  "provider_unavailable", "network", "timeout", "cancelled", "invalid_input", "backend_unavailable", "unknown",
];

/** Accepts only a well-formed error object from the server; anything else is treated as unknown. */
function readErrorInfo(value: unknown, status: number): AiErrorInfo {
  const raw = typeof value === "object" && value !== null ? (value as { error?: unknown }).error : undefined;
  if (typeof raw === "object" && raw !== null) {
    const e = raw as Partial<AiErrorInfo>;
    if (typeof e.kind === "string" && KINDS.includes(e.kind) && typeof e.message === "string") {
      return {
        kind: e.kind as AiErrorKind,
        message: e.message,
        provider: PROVIDER_IDS.includes(e.provider as ProviderId) ? (e.provider as ProviderId) : null,
        status: typeof e.status === "number" ? e.status : status,
        retryable: e.retryable === true,
        retryAfterMs: typeof e.retryAfterMs === "number" ? e.retryAfterMs : null,
      };
    }
  }
  return info("unknown", `The local backend answered with HTTP ${status}.`, status);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AiClientOptions {
  fetch?: FetchLike;
  /** Longest silence tolerated in a chat stream before giving up. */
  streamIdleMs?: number;
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === "AbortError";

export function createAiClient(options: AiClientOptions = {}) {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const streamIdleMs = options.streamIdleMs ?? 120_000;

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(path, { cache: "no-store", ...init });
    } catch (error) {
      if (isAbort(error)) throw new AiClientError(info("cancelled", "The request was cancelled."));
      throw new AiClientError(info("network", "Cannot reach the local backend. Is the app still running?", null, true));
    }
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await send(path, init);
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new AiClientError(readErrorInfo(body, response.status));
    return body as T;
  }

  const jsonInit = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  return {
    getSettings: () => call<AiSettingsView>("/api/ai/settings"),

    /** Blank or missing keys keep the saved key. `defaults: null` clears the defaults. */
    saveConfig: (patch: { keys?: Partial<Record<ProviderId, string>>; defaults?: { provider: ProviderId; model: string } | null }) =>
      call<AiSettingsView>("/api/ai/config", jsonInit("PUT", patch)),

    removeConfig: (provider: ProviderId | "all") => call<AiSettingsView>(`/api/ai/config?provider=${provider}`, { method: "DELETE" }),

    /** One provider (a failure throws) or, with no argument, every configured provider (failures are inside each catalog). */
    getModels: async (provider?: ProviderId, refresh = false, signal?: AbortSignal): Promise<ModelCatalog[]> => {
      const params = new URLSearchParams();
      if (provider) params.set("provider", provider);
      if (refresh) params.set("refresh", "1");
      const query = params.toString();
      return (await call<{ catalogs: ModelCatalog[] }>(`/api/ai/models${query ? `?${query}` : ""}`, { signal })).catalogs;
    },

    /** Reads a script against the indexed documentation (never runs it). Returns the same ScriptCheck the generator shows. */
    checkScript: (code: string, original?: string, signal?: AbortSignal) =>
      call<ScriptCheck>("/api/lua/check", jsonInit("POST", original === undefined ? { code } : { code, original }, signal)),

    /** A failed test is still a normal result (`ok: false` with `error`); only transport problems throw. */
    testConnection: (
      provider: ProviderId,
      test: { apiKey?: string; scope?: "key" | "model"; model?: string } = {},
      signal?: AbortSignal,
    ) => call<ConnectionTestResult>("/api/ai/test", jsonInit("POST", { provider, ...test }, signal)),

    /**
     * Streams a reply. Problems found before the provider accepted the request
     * throw an AiClientError; problems after that arrive as an `error` event.
     * The generator always ends with `done` or `error`, even when the connection
     * drops mid-reply.
     */
    async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
      const response = await send("/api/ai/chat", jsonInit("POST", request, signal));
      if (!response.ok) throw new AiClientError(readErrorInfo(await response.json().catch(() => null), response.status));
      if (!response.body) throw new AiClientError(info("unknown", "The reply had no body."));

      let finished = false;
      try {
        for await (const message of parseSse(iterateChunks(response.body, { idleMs: streamIdleMs, signal }))) {
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(message.data) as ChatStreamEvent;
          } catch {
            continue; // not one of ours (e.g. a keep-alive comment is already skipped by the parser)
          }
          if (event.type === "error") event = { type: "error", error: readErrorInfo({ error: event.error }, 200) };
          yield event;
          if (event.type === "done" || event.type === "error") {
            finished = true;
            return;
          }
        }
      } catch (error) {
        if (signal?.aborted || isAbort(error)) throw new AiClientError(info("cancelled", "The request was cancelled."));
        finished = true;
        yield error instanceof StreamIdleError
          ? { type: "error", error: info("timeout", "The provider stopped sending data.", null, true) }
          : { type: "error", error: info("network", "The connection was interrupted.", null, true) };
        return;
      }
      if (!finished) yield { type: "error", error: info("network", "The connection closed before the reply finished.", null, true) };
    },
  };
}

export type AiClient = ReturnType<typeof createAiClient>;

/** Default client for the app. */
export const aiClient: AiClient = createAiClient();
