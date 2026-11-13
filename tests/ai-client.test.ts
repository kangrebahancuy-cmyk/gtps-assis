/**
 * The browser-side client talking to the real backend handlers (Request in,
 * Response out) in front of a real AiService and local fake providers.
 * This is the path the settings page and the future chat UI will use.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { handleChat, handleGetSettings, handleModels, handleRemoveConfig, handleSaveConfig, handleTest } from "@/server/ai/api";
import { AiConfigStore } from "@/server/ai/config-store";
import { createGeminiProvider } from "@/server/ai/providers/gemini";
import { createGroqProvider } from "@/server/ai/providers/groq";
import { AiService } from "@/server/ai/service";
import { AiClientError, createAiClient, type FetchLike } from "@/services/ai-client";
import type { ChatStreamEvent } from "@/types/ai";
import { GEMINI_KEY, GROQ_KEY, startFakeGemini, startFakeGroq, type Fake } from "./ai-fakes";

let gemini: Fake;
let groq: Fake;
let dir: string;
let service: AiService;

before(async () => {
  [gemini, groq] = await Promise.all([startFakeGemini(), startFakeGroq()]);
});
after(async () => void (await Promise.all([gemini.close(), groq.close()])));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtps-client-"));
  gemini.setReply(["Hel", "lo ", "wörld ✓"]);
  groq.setReply(["Hel", "lo ", "wörld ✓"]);
  service = new AiService({
    store: new AiConfigStore(join(dir, "ai-config.json"), {}),
    providers: { gemini: createGeminiProvider(gemini.baseUrl), groq: createGroqProvider(groq.baseUrl) },
    sleep: async () => {},
    timeoutMs: 2000,
    streamIdleMs: 2000,
    retryBackoffMs: 10,
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  assert.equal(gemini.pending() + groq.pending(), 0);
});

/** A fetch that routes /api/ai/* to the handlers, as Next would. */
function backendFetch(log: Array<{ path: string; method: string; body: string | null }> = []): FetchLike {
  return async (path, init = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : null;
    log.push({ path, method, body });
    const request = new Request(`http://localhost:3000${path}`, {
      method,
      headers: { host: "localhost:3000", ...(init.headers as Record<string, string> | undefined) },
      body,
      signal: init.signal ?? undefined,
    });
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/api/ai/settings": return handleGetSettings(service)(request);
      case "/api/ai/config": return method === "DELETE" ? handleRemoveConfig(service)(request) : handleSaveConfig(service)(request);
      case "/api/ai/models": return handleModels(service)(request);
      case "/api/ai/test": return handleTest(service)(request);
      case "/api/ai/chat": return handleChat(service)(request);
      default: return new Response("{}", { status: 404 });
    }
  };
}

const collect = async (gen: AsyncGenerator<ChatStreamEvent>) => {
  const out: ChatStreamEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
};
const text = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
const hello = [{ role: "user" as const, content: "hi" }];

const failsWith = async (promise: Promise<unknown>, kind: string) => {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AiClientError, String(e));
    assert.equal(e.info.kind, kind, e.message);
    return e;
  }
  throw new Error(`expected ${kind}`);
};

describe("configuration through the client", () => {
  it("saves keys and defaults, reads settings back, tests, lists models and removes", async () => {
    const log: Array<{ path: string; method: string; body: string | null }> = [];
    const client = createAiClient({ fetch: backendFetch(log) });

    const empty = await client.getSettings();
    assert.equal(empty.providers.some((p) => p.configured), false);

    const saved = await client.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    assert.deepEqual(saved.defaults, { provider: "groq", model: "llama-demo-70b" });
    assert.doesNotMatch(JSON.stringify(await client.getSettings()), new RegExp(`${GEMINI_KEY}|${GROQ_KEY}`));

    const catalogs = await client.getModels();
    assert.deepEqual(catalogs.map((c) => [c.provider, c.models.length]), [["gemini", 4], ["groq", 4]]);
    assert.equal((await client.getModels("groq", true))[0]!.provider, "groq");
    assert.ok(log.some((r) => r.path === "/api/ai/models?provider=groq&refresh=1"));

    const test = await client.testConnection("gemini", { scope: "model", model: "gemini-alpha" });
    assert.deepEqual([test.ok, test.testedModel], [true, "gemini-alpha"]);

    const afterRemove = await client.removeConfig("groq");
    assert.deepEqual(afterRemove.providers.map((p) => p.configured), [true, false]);
    assert.equal((await client.removeConfig("all")).providers.some((p) => p.configured), false);
  });
  it("sends only the typed keys, and never anything about keys it did not receive", async () => {
    const log: Array<{ path: string; method: string; body: string | null }> = [];
    const client = createAiClient({ fetch: backendFetch(log) });
    await client.saveConfig({ keys: { groq: GROQ_KEY } });
    assert.deepEqual(JSON.parse(log.at(-1)!.body!), { keys: { groq: GROQ_KEY } });
    await client.getSettings();
    assert.equal(log.at(-1)!.body, null);
  });
  it("turns backend errors into AiClientError with the server's kind and a safe message", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    await failsWith(client.saveConfig({ keys: { groq: "short" } }), "invalid_input");
    await failsWith(client.getModels("gemini"), "not_configured");
    await client.saveConfig({ keys: { gemini: "AIzaSyBAD_KEY_000000000000000000000" } });
    const e = await failsWith(client.getModels("gemini"), "invalid_key");
    assert.equal(e.info.status, 400, "the provider's own status is kept (Gemini reports a bad key as HTTP 400)");
    assert.equal(e.info.provider, "gemini");
  });
  it("a failed connection test is a result, not an exception", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    const result = await client.testConnection("groq", { apiKey: "gsk_NOPE_NOPE_NOPE_00000000000000" });
    assert.deepEqual([result.ok, result.error?.kind], [false, "invalid_key"]);
  });
  it("reports an unreachable backend and a non-JSON error page as errors, not crashes", async () => {
    const down = createAiClient({ fetch: async () => { throw new TypeError("fetch failed"); } });
    const e = await failsWith(down.getSettings(), "network");
    assert.equal(e.info.retryable, true);
    const html = createAiClient({ fetch: async () => new Response("<html>Bad Gateway</html>", { status: 502 }) });
    const e2 = await failsWith(html.getSettings(), "unknown");
    assert.match(e2.message, /HTTP 502/);
    const weird = createAiClient({ fetch: async () => Response.json({ error: { kind: "made_up", message: 5 } }, { status: 500 }) });
    await failsWith(weird.getSettings(), "unknown");
  });
});

describe("streamChat", () => {
  it("streams events from the default provider and ends with done", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    await client.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    const events = await collect(client.streamChat({ messages: hello }));
    assert.deepEqual(events[0], { type: "start", provider: "groq", model: "llama-demo-70b" });
    assert.equal(text(events), "Hello wörld ✓");
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
  });
  it("switching provider changes the answer, not the calling code", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    await client.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } });
    gemini.setReply(["from gemini"]);
    groq.setReply(["from groq"]);
    const ask = async () => collect(client.streamChat({ messages: hello }));
    const first = await ask();
    await client.saveConfig({ defaults: { provider: "groq", model: "llama-demo-70b" } });
    const second = await ask();
    assert.deepEqual([text(first), text(second)], ["from gemini", "from groq"]);
    assert.deepEqual(second.map((e) => e.type), first.map((e) => e.type));
    const viaRequest = await collect(client.streamChat({ messages: hello, provider: "gemini", model: "gemini-alpha" }));
    assert.equal(text(viaRequest), "from gemini");
  });
  it("throws AiClientError for problems found before the stream starts", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    await failsWith(collect(client.streamChat({ messages: hello })), "not_configured");
    await client.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    await failsWith(collect(client.streamChat({ messages: [] })), "invalid_input");
    groq.queue({ status: 429, headers: { "retry-after": "90" }, body: JSON.stringify({ error: { message: "slow", code: "rate_limit_exceeded" } }) });
    const e = await failsWith(collect(client.streamChat({ messages: hello })), "rate_limited");
    assert.equal(e.info.retryAfterMs, 90_000);
  });
  it("delivers an error that happens mid-stream as a final error event", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    await client.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')], destroyAfterStream: true });
    const events = await collect(client.streamChat({ messages: hello }));
    assert.deepEqual(events.map((e) => e.type), ["start", "delta", "error"]);
    assert.equal(text(events), "partial");
  });
  it("always ends with done or error: a connection that just closes becomes a network error", async () => {
    const cut: FetchLike = async () => new Response('data: {"type":"start","provider":"groq","model":"m"}\n\ndata: {"type":"delta","text":"hi"}\n\n', { headers: { "content-type": "text/event-stream" } });
    const events = await collect(createAiClient({ fetch: cut }).streamChat({ messages: hello }));
    assert.deepEqual(events.map((e) => e.type), ["start", "delta", "error"]);
    assert.equal((events.at(-1) as { error: { kind: string; retryable: boolean } }).error.kind, "network");
  });
  it("a silent stream times out with a timeout error event", async () => {
    const silent: FetchLike = async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { headers: { "content-type": "text/event-stream" } });
    const events = await collect(createAiClient({ fetch: silent, streamIdleMs: 30 }).streamChat({ messages: hello }));
    assert.deepEqual(events.map((e) => e.type), ["error"]);
    assert.equal((events[0] as { error: { kind: string } }).error.kind, "timeout");
  });
  it("ignores malformed events and sanitises an unexpected error shape", async () => {
    const odd: FetchLike = async () => new Response('data: not json\n\ndata: {"type":"delta","text":"ok"}\n\ndata: {"type":"error","error":{"kind":"???","message":"boom"}}\n\n', { headers: { "content-type": "text/event-stream" } });
    const events = await collect(createAiClient({ fetch: odd }).streamChat({ messages: hello }));
    assert.deepEqual(events.map((e) => e.type), ["delta", "error"]);
    assert.equal((events[1] as { error: { kind: string } }).error.kind, "unknown");
  });
  it("cancelling stops the stream and raises a cancelled error, releasing the provider connection", async () => {
    const client = createAiClient({ fetch: backendFetch() });
    await client.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')], holdOpen: true });
    const controller = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const event of client.streamChat({ messages: hello }, controller.signal)) {
        seen.push(event.type);
        if (event.type === "delta") controller.abort();
      }
    })();
    await failsWith(run, "cancelled");
    assert.deepEqual(seen, ["start", "delta"]);
    await failsWith(collect(client.streamChat({ messages: hello }, controller.signal)), "cancelled");
  });
});
