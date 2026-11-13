import { assertLocalRequest } from "@/server/ai/guard";
import { AiError, toErrorInfo } from "@/server/ai/errors";
import type { AiService } from "@/server/ai/service";
import { validateApiKey, validateChatRequest, validateModelId, validateProvider } from "@/server/ai/validate";
import { PROVIDER_IDS, type AiDefaults, type AiErrorKind, type ChatStreamEvent, type ProviderId } from "@/types/ai";

/**
 * HTTP handlers for /api/ai/*. They use only the standard Request/Response, so
 * the route files are one-liners and the handlers can be tested without Next.js.
 */

const STATUS: Record<AiErrorKind, number> = {
  invalid_input: 400,
  not_configured: 409,
  cancelled: 400,
  invalid_key: 401,
  permission_denied: 403,
  model_not_found: 404,
  bad_request: 400,
  rate_limited: 429,
  content_blocked: 422,
  provider_unavailable: 502,
  network: 502,
  timeout: 504,
  unknown: 500,
};

const NO_STORE = { "cache-control": "no-store" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

export function errorResponse(error: unknown, provider: ProviderId | null = null): Response {
  const info = toErrorInfo(error, provider);
  const headers: Record<string, string> = {};
  if (info.kind === "rate_limited" && info.retryAfterMs !== null) headers["retry-after"] = String(Math.max(1, Math.ceil(info.retryAfterMs / 1000)));
  return json({ error: info }, STATUS[info.kind], headers);
}

async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const text = await request.text();
  if (text.length > maxBytes) throw new AiError("invalid_input", "The request body is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError("invalid_input", "The request body is not valid JSON.");
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Wraps a handler: local-request checks first, then safe error mapping. */
function guarded(mutation: boolean, handler: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request, { mutation });
      return await handler(request);
    } catch (error) {
      return errorResponse(error);
    }
  };
}

export const handleGetSettings = (service: AiService) => guarded(false, async () => json(service.getSettings()));

/** PUT { keys?: {gemini?, groq?}, defaults?: {provider, model} | null } */
export const handleSaveConfig = (service: AiService) =>
  guarded(true, async (request) => {
    const body = await readJson(request, 16_384);
    if (!isObject(body)) throw new AiError("invalid_input", "The request body must be a JSON object.");

    const keys: Partial<Record<ProviderId, string>> = {};
    if (body.keys !== undefined) {
      if (!isObject(body.keys)) throw new AiError("invalid_input", "keys must be an object.");
      for (const [id, value] of Object.entries(body.keys)) {
        if (value === "" || value === null || value === undefined) continue; // blank field: keep the saved key
        keys[validateProvider(id)] = validateApiKey(value);
      }
    }
    let defaults: AiDefaults | null | undefined;
    if (body.defaults === null) defaults = null;
    else if (body.defaults !== undefined) {
      if (!isObject(body.defaults)) throw new AiError("invalid_input", "defaults must be an object or null.");
      defaults = { provider: validateProvider(body.defaults.provider), model: validateModelId(body.defaults.model) };
    }
    return json(await service.saveConfig({ keys, defaults }));
  });

/** DELETE ?provider=gemini|groq|all */
export const handleRemoveConfig = (service: AiService) =>
  guarded(false, async (request) => {
    // DELETE has no body, so the JSON content-type rule does not apply; the host/origin checks still do.
    const target = new URL(request.url).searchParams.get("provider");
    return json(service.removeConfig(target === "all" ? "all" : validateProvider(target)));
  });

/** GET ?provider=gemini&refresh=1 */
export const handleModels = (service: AiService) =>
  guarded(false, async (request) => {
    const params = new URL(request.url).searchParams;
    const refresh = params.get("refresh") === "1";
    const requested = params.get("provider");
    if (requested === null) return json({ catalogs: await service.listAllModels({ refresh, signal: request.signal }) });
    const provider = validateProvider(requested);
    return json({ catalogs: [await service.listModels(provider, { refresh, signal: request.signal })] });
  });

/** POST { provider, scope?: "key"|"model", apiKey?, model? } -> ConnectionTestResult (200 even when the test fails). */
export const handleTest = (service: AiService) =>
  guarded(true, async (request) => {
    const body = await readJson(request, 16_384);
    if (!isObject(body)) throw new AiError("invalid_input", "The request body must be a JSON object.");
    const provider = validateProvider(body.provider);
    if (body.scope !== undefined && body.scope !== "key" && body.scope !== "model") throw new AiError("invalid_input", 'scope must be "key" or "model".');
    return json(
      await service.testConnection(provider, {
        apiKey: body.apiKey === undefined || body.apiKey === "" ? undefined : validateApiKey(body.apiKey),
        scope: body.scope,
        model: body.model === undefined ? undefined : validateModelId(body.model),
        signal: request.signal,
      }),
    );
  });

const encoder = new TextEncoder();
const sse = (event: ChatStreamEvent): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

/**
 * POST ChatRequest -> text/event-stream of ChatStreamEvent. Errors raised before
 * the provider produced anything (no key, bad input, local cooldown, rejected key)
 * are returned as normal JSON error responses with a matching status; errors after that
 * arrive as a final `error` event.
 */
export const handleChat = (service: AiService) =>
  guarded(true, async (request) => {
    const chat = validateChatRequest(await readJson(request, 1_000_000));
    const abort = new AbortController();
    request.signal.addEventListener("abort", () => abort.abort(), { once: true });

    const iterator = service.streamChat(chat, abort.signal)[Symbol.asyncIterator]();
    const buffered: ChatStreamEvent[] = [];
    let finished = false;
    try {
      // `start` is held back until the provider has accepted the request.
      for (;;) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        buffered.push(next.value);
        if (next.value.type !== "start") break;
      }
    } catch (error) {
      abort.abort();
      throw error;
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of buffered) controller.enqueue(sse(event));
        if (finished) controller.close();
      },
      async pull(controller) {
        if (finished) return;
        try {
          const next = await iterator.next();
          if (next.done) {
            finished = true;
            controller.close();
          } else controller.enqueue(sse(next.value));
        } catch (error) {
          finished = true;
          controller.enqueue(sse({ type: "error", error: toErrorInfo(error) }));
          controller.close();
        }
      },
      async cancel() {
        abort.abort();
        await iterator.return?.(undefined);
      },
    });
    return new Response(body, {
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
    });
  });

export const ALL_PROVIDERS = PROVIDER_IDS;
