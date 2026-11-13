/**
 * Local stand-ins for the Gemini and Groq HTTP APIs, used to exercise the real
 * adapters over real HTTP. They imitate the documented request/response shapes
 * (Gemini: models.list + streamGenerateContent?alt=sse, error JSON with
 * details/retryDelay; Groq: OpenAI-compatible /models and /chat/completions SSE
 * with x-ratelimit-* headers and Retry-After). They are NOT the real services,
 * so these tests cannot prove the real services behave the same.
 */
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Replaces the normal answer to the next request (after the key check). */
export interface Override {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  /** Stream these raw byte chunks as a 200 event stream. */
  stream?: Buffer[];
  /** Close the connection after streaming `stream` (a truncated stream). */
  destroyAfterStream?: boolean;
  /** Keep the response open (silent) after streaming `stream`. */
  holdOpen?: boolean;
  /** Milliseconds between streamed chunks (default 2). */
  chunkDelayMs?: number;
  /** Never answer. */
  hang?: boolean;
  /** Drop the connection without answering. */
  destroy?: boolean;
}

export interface Fake {
  baseUrl: string;
  validKey: string;
  requests: FakeRequest[];
  queue(override: Override): void;
  /** Overrides queued but not yet used; tests assert this is 0 so nothing leaks into the next test. */
  pending(): number;
  /** Replaces the text pieces of the default chat reply. */
  setReply(parts: string[]): void;
  close(): Promise<void>;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Splits bytes every `size` bytes, ignoring character boundaries (to prove the parser reassembles them). */
export function splitBytes(text: string, size: number): Buffer[] {
  const bytes = Buffer.from(text, "utf8");
  const out: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

async function writeChunks(res: ServerResponse, chunks: Buffer[], delayMs = 2): Promise<void> {
  for (const chunk of chunks) {
    if (res.destroyed) return;
    res.write(chunk);
    await sleep(delayMs);
  }
}

interface Spec {
  validKey: string;
  /** Returns true when the request carries the valid key. */
  authorized(req: FakeRequest): boolean;
  rejectKey(res: ServerResponse): void;
  routes(req: FakeRequest, parts: string[]): { kind: "models" | "chat" | "none"; page?: number };
  models(page: number): { body: unknown; headers?: Record<string, string> };
  chat(req: FakeRequest, parts: string[]): { stream: Buffer[]; headers?: Record<string, string> };
}

async function start(spec: Spec): Promise<Fake> {
  const requests: FakeRequest[] = [];
  const overrides: Override[] = [];
  let reply = ["Hel", "lo ", "wörld ✓"];

  const server = createServer((incoming, res) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (c: Buffer) => chunks.push(c));
    incoming.on("end", async () => {
      const req: FakeRequest = { method: incoming.method ?? "GET", url: incoming.url ?? "/", headers: incoming.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(req);

      if (!spec.authorized(req)) return spec.rejectKey(res);
      const route = spec.routes(req, reply);
      const override = overrides.shift();
      if (override) {
        if (override.destroy) return incoming.socket.destroy();
        if (override.hang) return;
        if (override.stream) {
          res.writeHead(200, { "content-type": "text/event-stream", ...override.headers });
          await writeChunks(res, override.stream, override.chunkDelayMs);
          if (override.destroyAfterStream) return incoming.socket.destroy();
          if (override.holdOpen) return;
          return res.end();
        }
        res.writeHead(override.status ?? 200, { "content-type": "application/json", ...override.headers });
        return res.end(override.body ?? "");
      }

      if (route.kind === "models") {
        const { body, headers } = spec.models(route.page ?? 0);
        res.writeHead(200, { "content-type": "application/json", ...headers });
        return res.end(JSON.stringify(body));
      }
      if (route.kind === "chat") {
        const { stream, headers } = spec.chat(req, reply);
        res.writeHead(200, { "content-type": "text/event-stream", ...headers });
        await writeChunks(res, stream);
        return res.end();
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    validKey: spec.validKey,
    requests,
    queue: (o) => void overrides.push(o),
    pending: () => overrides.length,
    setReply: (parts) => void (reply = parts),
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

// ---- Gemini -----------------------------------------------------------------

export const GEMINI_KEY = "AIzaSyFAKE_gemini_key_for_tests_0000000";

export const geminiModels = [
  { name: "models/gemini-alpha", baseModelId: "gemini-alpha", version: "1", displayName: "Gemini Alpha", description: "General model", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"], thinking: true },
  { name: "models/gemini-beta-flash", version: "2", displayName: "Gemini Beta Flash", inputTokenLimit: 32768, outputTokenLimit: 8192, supportedGenerationMethods: ["generateContent", "streamGenerateContent"] },
  { name: "models/text-embedder", version: "1", displayName: "Text Embedder", inputTokenLimit: 2048, outputTokenLimit: 1, supportedGenerationMethods: ["embedContent"] },
  { name: "models/codegemma-demo", version: "1", displayName: "CodeGemma Demo", inputTokenLimit: 8192, outputTokenLimit: 2048, supportedGenerationMethods: ["generateContent"] },
];

const sseData = (obj: unknown) => `data: ${JSON.stringify(obj)}\r\n\r\n`;

export function geminiStream(parts: string[], finishReason = "STOP"): Buffer[] {
  const events = parts.map((text, i) => sseData({
    candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: i === parts.length - 1 ? finishReason : "", index: 0 }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: i + 1, totalTokenCount: 6 + i },
  }));
  return splitBytes(events.join(""), 7);
}

export function startFakeGemini(): Promise<Fake> {
  return start({
    validKey: GEMINI_KEY,
    authorized: (req) => req.headers["x-goog-api-key"] === GEMINI_KEY,
    rejectKey: (res) => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 400, message: "API key not valid. Please pass a valid API key.", status: "INVALID_ARGUMENT", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }] } }));
    },
    routes: (req) => {
      if (req.method === "GET" && req.url.startsWith("/models")) {
        const token = new URL(req.url, "http://x").searchParams.get("pageToken");
        return { kind: "models", page: token === "page2" ? 1 : 0 };
      }
      if (req.method === "POST" && /^\/models\/[^/]+:streamGenerateContent\?alt=sse$/.test(req.url)) return { kind: "chat" };
      return { kind: "none" };
    },
    models: (page) => ({ body: page === 0 ? { models: geminiModels.slice(0, 2), nextPageToken: "page2" } : { models: geminiModels.slice(2) } }),
    chat: (_req, parts) => ({ stream: geminiStream(parts) }),
  });
}

// ---- Groq -------------------------------------------------------------------

export const GROQ_KEY = "gsk_FAKEgroqkeyfortests0000000000";

export const groqModels = [
  { id: "llama-demo-70b", object: "model", created: 1, owned_by: "Meta", active: true, context_window: 131072, max_completion_tokens: 32768 },
  { id: "qwen-coder-demo", object: "model", created: 2, owned_by: "Alibaba", active: true, context_window: 32768 },
  { id: "whisper-demo", object: "model", created: 3, owned_by: "OpenAI", active: true, context_window: 448 },
  { id: "retired-demo", object: "model", created: 4, owned_by: "Someone", active: false, context_window: 8192 },
];

export const GROQ_RATE_HEADERS = {
  "x-ratelimit-limit-requests": "14400",
  "x-ratelimit-limit-tokens": "18000",
  "x-ratelimit-remaining-requests": "14370",
  "x-ratelimit-remaining-tokens": "17997",
  "x-ratelimit-reset-requests": "2m59.56s",
  "x-ratelimit-reset-tokens": "7.66s",
};

export function groqStream(parts: string[], finishReason = "stop", withUsage = true): Buffer[] {
  const events = parts.map((content, i) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content } : { content }, finish_reason: null }] })}\n\n`);
  events.push(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(withUsage ? { x_groq: { usage: { prompt_tokens: 4, completion_tokens: parts.length, total_tokens: 4 + parts.length } } } : {}) })}\n\n`);
  events.push("data: [DONE]\n\n");
  return splitBytes(events.join(""), 11);
}

export function startFakeGroq(): Promise<Fake> {
  return start({
    validKey: GROQ_KEY,
    authorized: (req) => req.headers.authorization === `Bearer ${GROQ_KEY}`,
    rejectKey: (res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API Key", type: "invalid_request_error", code: "invalid_api_key" } }));
    },
    routes: (req) => {
      if (req.method === "GET" && req.url === "/models") return { kind: "models" };
      if (req.method === "POST" && req.url === "/chat/completions") return { kind: "chat" };
      return { kind: "none" };
    },
    models: () => ({ body: { object: "list", data: groqModels }, headers: GROQ_RATE_HEADERS }),
    chat: (_req, parts) => ({ stream: groqStream(parts), headers: GROQ_RATE_HEADERS }),
  });
}

/** One Buffer per server-sent event (so a delay between chunks is a delay between pieces of text). */
export function groqEvents(parts: string[], finishReason = "stop"): Buffer[] {
  const chunk = (delta: object, finish: string | null) => Buffer.from(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  return [...parts.map((content, i) => chunk(i === 0 ? { role: "assistant", content } : { content }, null)), chunk({}, finishReason), Buffer.from("data: [DONE]\n\n")];
}
