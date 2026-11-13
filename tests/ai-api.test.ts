/**
 * The /api/ai/* handlers, driven with real Request objects against a real
 * AiService and local fake providers: local-only guard, validation, status
 * mapping, SSE streaming, and that no response ever contains an API key.
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
import { parseSse } from "@/lib/sse";
import type { ChatStreamEvent } from "@/types/ai";
import { GEMINI_KEY, GROQ_KEY, GROQ_RATE_HEADERS, startFakeGemini, startFakeGroq, type Fake } from "./ai-fakes";

let gemini: Fake;
let groq: Fake;
let dir: string;
let clock: number;
let service: AiService;
const seen: string[] = []; // every response body, scanned for keys at the end

before(async () => {
  [gemini, groq] = await Promise.all([startFakeGemini(), startFakeGroq()]);
});
after(async () => {
  await Promise.all([gemini.close(), groq.close()]);
  const all = seen.join("\n");
  for (const secret of [GEMINI_KEY, GROQ_KEY, "gsk_NOPE_NOPE_NOPE_00000000000000"]) assert.equal(all.includes(secret), false, `a response leaked ${secret.slice(0, 6)}…`);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtps-api-"));
  clock = 5_000_000;
  gemini.setReply(["Hel", "lo ", "wörld ✓"]);
  groq.setReply(["Hel", "lo ", "wörld ✓"]);
  service = new AiService({
    store: new AiConfigStore(join(dir, "ai-config.json"), {}),
    providers: { gemini: createGeminiProvider(gemini.baseUrl), groq: createGroqProvider(groq.baseUrl) },
    now: () => clock,
    sleep: async () => {},
    timeoutMs: 2000,
    streamIdleMs: 2000,
    retryBackoffMs: 10,
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  assert.equal(gemini.pending() + groq.pending(), 0, "leaked override");
});

const BASE = "http://localhost:3000";
function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Request {
  const raw = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Request(`${BASE}${path}`, {
    method,
    headers: { host: "localhost:3000", ...(raw !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: raw,
  });
}
async function read(res: Response): Promise<any> {
  const text = await res.text();
  seen.push(text);
  return text ? JSON.parse(text) : null;
}
async function events(res: Response): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  assert.ok(res.body);
  for await (const m of parseSse(res.body as unknown as AsyncIterable<Uint8Array>)) {
    seen.push(m.data);
    out.push(JSON.parse(m.data) as ChatStreamEvent);
  }
  return out;
}
const configure = async (defaults = { provider: "groq", model: "llama-demo-70b" }) => {
  const res = await handleSaveConfig(service)(req("PUT", "/api/ai/config", { keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults }));
  assert.equal(res.status, 200, JSON.stringify(await read(res.clone())));
  return read(res);
};
const chat = (body: unknown, headers?: Record<string, string>) => handleChat(service)(req("POST", "/api/ai/chat", body, headers));
const hello = [{ role: "user", content: "hi" }];

describe("local-only guard", () => {
  it("answers requests addressed to localhost, 127.0.0.1 and [::1]", async () => {
    for (const host of ["localhost:3000", "127.0.0.1:3000", "[::1]:3000", "LOCALHOST"]) {
      assert.equal((await handleGetSettings(service)(req("GET", "/api/ai/settings", undefined, { host }))).status, 200, host);
    }
  });
  it("refuses a foreign Host (DNS rebinding), cross-site and cross-origin requests, opaque origins", async () => {
    const bad: Record<string, string>[] = [
      { host: "evil.example.com" },
      { host: "localhost.evil.com:3000" },
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example.com" },
      { origin: "http://localhost:4000" },
      { origin: "null" },
      { origin: "not a url" },
    ];
    for (const headers of bad) {
      const res = await handleGetSettings(service)(req("GET", "/api/ai/settings", undefined, headers));
      assert.equal(res.status, 400, JSON.stringify(headers));
      assert.equal((await read(res)).error.kind, "invalid_input");
    }
    assert.equal((await handleGetSettings(service)(req("GET", "/api/ai/settings", undefined, { origin: BASE, "sec-fetch-site": "same-origin" }))).status, 200);
  });
  it("requires JSON for every mutating request", async () => {
    const res = await handleSaveConfig(service)(new Request(`${BASE}/api/ai/config`, { method: "PUT", headers: { host: "localhost:3000", "content-type": "text/plain" }, body: "{}" }));
    assert.equal(res.status, 400);
    assert.match((await read(res)).error.message, /application\/json/);
    const chatRes = await handleChat(service)(new Request(`${BASE}/api/ai/chat`, { method: "POST", headers: { host: "localhost:3000" }, body: "{}" }));
    assert.equal(chatRes.status, 400);
    await chatRes.text();
  });
  it("sends no-store on every kind of response", async () => {
    assert.equal((await handleGetSettings(service)(req("GET", "/x"))).headers.get("cache-control"), "no-store");
    assert.equal((await handleGetSettings(service)(req("GET", "/x", undefined, { host: "evil.com" }))).headers.get("cache-control"), "no-store");
  });
});

describe("settings and configuration endpoints", () => {
  it("saving returns the new settings with key hints only", async () => {
    const settings = await configure();
    assert.deepEqual(settings.providers.map((p: any) => [p.provider, p.configured, p.keyHint]), [["gemini", true, `…${GEMINI_KEY.slice(-4)}`], ["groq", true, `…${GROQ_KEY.slice(-4)}`]]);
    assert.deepEqual(settings.defaults, { provider: "groq", model: "llama-demo-70b" });
    const again = await read(await handleGetSettings(service)(req("GET", "/api/ai/settings")));
    assert.deepEqual(again.defaults, settings.defaults);
  });
  it("blank key fields keep the saved key", async () => {
    await configure();
    const res = await handleSaveConfig(service)(req("PUT", "/api/ai/config", { keys: { gemini: "", groq: null }, defaults: { provider: "gemini", model: "gemini-alpha" } }));
    const settings = await read(res);
    assert.equal(res.status, 200);
    assert.deepEqual(settings.providers.map((p: any) => p.configured), [true, true]);
    assert.equal(settings.defaults.provider, "gemini");
  });
  it("rejects malformed input with 400 and changes nothing", async () => {
    const cases: unknown[] = [
      "not json",
      "[]",
      '"string"',
      { keys: "x" },
      { keys: { openai: GROQ_KEY } },
      { keys: { groq: 123 } },
      { keys: { groq: "short" } },
      { keys: { groq: "has space in key 123" } },
      { defaults: "x" },
      { defaults: { provider: "groq" } },
      { defaults: { provider: "nope", model: "m" } },
      { defaults: { provider: "groq", model: "bad model!" } },
      { defaults: { provider: "groq", model: "../etc/passwd" } },
    ];
    for (const body of cases) {
      const res = await handleSaveConfig(service)(req("PUT", "/api/ai/config", body));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal((await read(res)).error.kind, "invalid_input");
    }
    assert.equal(service.getSettings().providers.some((p) => p.configured), false);
    const huge = await handleSaveConfig(service)(req("PUT", "/api/ai/config", { keys: { groq: "k".repeat(20_000) } }));
    assert.equal(huge.status, 400);
    await huge.text();
  });
  it("rejects an unknown or unlisted default model with 400 and keeps the previous state", async () => {
    await configure();
    const res = await handleSaveConfig(service)(req("PUT", "/api/ai/config", { defaults: { provider: "groq", model: "no-such-model" } }));
    assert.equal(res.status, 400);
    assert.deepEqual(service.getSettings().defaults, { provider: "groq", model: "llama-demo-70b" });
    await res.text();
  });
  it("removes one provider or all of them", async () => {
    await configure();
    const one = await read(await handleRemoveConfig(service)(req("DELETE", "/api/ai/config?provider=groq")));
    assert.deepEqual(one.providers.map((p: any) => p.configured), [true, false]);
    assert.deepEqual(one.defaults, { provider: null, model: null });
    const all = await read(await handleRemoveConfig(service)(req("DELETE", "/api/ai/config?provider=all")));
    assert.equal(all.providers.some((p: any) => p.configured), false);
    const bad = await handleRemoveConfig(service)(req("DELETE", "/api/ai/config?provider=openai"));
    assert.equal(bad.status, 400);
    await bad.text();
    const missing = await handleRemoveConfig(service)(req("DELETE", "/api/ai/config"));
    assert.equal(missing.status, 400);
    await missing.text();
  });
});

describe("models and connection test endpoints", () => {
  it("lists models for all providers or one, with refresh", async () => {
    await configure();
    const all = await read(await handleModels(service)(req("GET", "/api/ai/models")));
    assert.deepEqual(all.catalogs.map((c: any) => [c.provider, c.models.length]), [["gemini", 4], ["groq", 4]]);
    const one = await read(await handleModels(service)(req("GET", "/api/ai/models?provider=groq&refresh=1")));
    assert.deepEqual(one.catalogs.map((c: any) => c.provider), ["groq"]);
    const model = one.catalogs[0].models[0];
    assert.equal(model.provider, "groq");
    assert.equal(model.freeTier, "unverified");
    const bad = await handleModels(service)(req("GET", "/api/ai/models?provider=x"));
    assert.equal(bad.status, 400);
    await bad.text();
  });
  it("reports 'not configured' as 200 with an empty list for all, and 409 for a single named provider", async () => {
    const all = await handleModels(service)(req("GET", "/api/ai/models"));
    assert.equal(all.status, 200);
    assert.deepEqual((await read(all)).catalogs, []);
    const one = await handleModels(service)(req("GET", "/api/ai/models?provider=gemini"));
    assert.equal(one.status, 409);
    assert.equal((await read(one)).error.kind, "not_configured");
  });
  it("maps a rejected key on model discovery to 401", async () => {
    await handleSaveConfig(service)(req("PUT", "/api/ai/config", { keys: { gemini: "AIzaSyBAD_KEY_000000000000000000000" } })).then((r) => r.text());
    const res = await handleModels(service)(req("GET", "/api/ai/models?provider=gemini"));
    assert.equal(res.status, 401);
    assert.equal((await read(res)).error.kind, "invalid_key");
  });
  it("tests a candidate key and reports failure as a 200 result, not an HTTP error", async () => {
    const ok = await read(await handleTest(service)(req("POST", "/api/ai/test", { provider: "gemini", apiKey: GEMINI_KEY })));
    assert.deepEqual([ok.ok, ok.scope, ok.modelCount], [true, "key", 4]);
    const bad = await handleTest(service)(req("POST", "/api/ai/test", { provider: "groq", apiKey: "gsk_NOPE_NOPE_NOPE_00000000000000" }));
    assert.equal(bad.status, 200);
    const body = await read(bad);
    assert.deepEqual([body.ok, body.error.kind], [false, "invalid_key"]);
    assert.equal(service.getSettings().providers.some((p) => p.configured), false, "tested keys are not saved");
  });
  it("tests a model with a tiny generation", async () => {
    await configure();
    const body = await read(await handleTest(service)(req("POST", "/api/ai/test", { provider: "groq", scope: "model", model: "llama-demo-70b" })));
    assert.deepEqual([body.ok, body.testedModel], [true, "llama-demo-70b"]);
  });
  it("validates test input", async () => {
    for (const body of [{}, { provider: "x" }, { provider: "groq", scope: "all" }, { provider: "groq", apiKey: "short" }, { provider: "groq", model: "bad model" }, "nope", []]) {
      const res = await handleTest(service)(req("POST", "/api/ai/test", body));
      assert.equal(res.status, 400, JSON.stringify(body));
      await res.text();
    }
  });
});

describe("chat endpoint", () => {
  it("streams start, deltas and done as server-sent events (default provider)", async () => {
    await configure();
    const res = await chat({ messages: hello });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/event-stream/);
    const out = await events(res);
    assert.deepEqual(out[0], { type: "start", provider: "groq", model: "llama-demo-70b" });
    assert.equal(out.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join(""), "Hello wörld ✓");
    assert.deepEqual(out.at(-1), { type: "done", finishReason: "stop" });
  });
  it("the same request works against either provider; only the event's provider differs", async () => {
    await configure();
    const viaGroq = await events(await chat({ messages: hello, provider: "groq", model: "llama-demo-70b" }));
    const viaGemini = await events(await chat({ messages: hello, provider: "gemini", model: "gemini-alpha" }));
    assert.deepEqual(viaGroq.map((e) => e.type), viaGemini.map((e) => e.type));
    assert.deepEqual([(viaGroq[0] as any).provider, (viaGemini[0] as any).provider], ["groq", "gemini"]);
  });
  it("passes temperature and maxOutputTokens through", async () => {
    await configure();
    await events(await chat({ messages: hello, temperature: 0.3, maxOutputTokens: 77 }));
    const sent = JSON.parse(groq.requests.at(-1)!.body);
    assert.equal(sent.temperature, 0.3);
    assert.equal(sent.max_completion_tokens, 77);
  });
  it("rejects invalid chat input with 400 before contacting any provider", async () => {
    await configure();
    const before = gemini.requests.length + groq.requests.length;
    const huge = "x".repeat(100_001);
    const cases: unknown[] = [
      {},
      { messages: [] },
      { messages: "hi" },
      { messages: [{ role: "user" }] },
      { messages: [{ role: "robot", content: "x" }] },
      { messages: [{ role: "user", content: "  " }] },
      { messages: [{ role: "assistant", content: "only assistant" }] },
      { messages: [{ role: "user", content: huge }] },
      { messages: Array.from({ length: 101 }, () => ({ role: "user", content: "x" })) },
      { messages: hello, temperature: 5 },
      { messages: hello, temperature: "hot" },
      { messages: hello, maxOutputTokens: 0 },
      { messages: hello, maxOutputTokens: 1.5 },
      { messages: hello, maxOutputTokens: 10_000_000 },
      { messages: hello, provider: "openai" },
      { messages: hello, model: "bad model!" },
      "not json",
    ];
    for (const body of cases) {
      const res = await chat(body);
      assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal((await read(res)).error.kind, "invalid_input");
    }
    assert.equal(gemini.requests.length + groq.requests.length, before);
  });
  it("before any stream starts, errors are normal JSON responses with a matching status", async () => {
    const none = await chat({ messages: hello });
    assert.equal(none.status, 409);
    assert.equal((await read(none)).error.kind, "not_configured");

    await configure();
    groq.queue({ status: 401, body: JSON.stringify({ error: { message: "Invalid API Key", code: "invalid_api_key" } }) });
    const bad = await chat({ messages: hello });
    assert.equal(bad.status, 401);
    assert.equal((await read(bad)).error.kind, "invalid_key");

    gemini.queue({ status: 404, body: JSON.stringify({ error: { code: 404, message: "model not found", status: "NOT_FOUND" } }) });
    const missing = await chat({ messages: hello, provider: "gemini", model: "gemini-alpha" });
    assert.equal(missing.status, 404);
    assert.equal((await read(missing)).error.kind, "model_not_found");
  });
  it("a rate limit returns 429 with Retry-After, then the local cooldown answers without any network call", async () => {
    await configure();
    groq.queue({ status: 429, headers: { ...GROQ_RATE_HEADERS, "retry-after": "90" }, body: JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }) });
    const first = await chat({ messages: hello });
    assert.equal(first.status, 429);
    assert.equal(first.headers.get("retry-after"), "90");
    assert.equal((await read(first)).error.retryAfterMs, 90_000);

    const requests = groq.requests.length;
    clock += 30_000;
    const second = await chat({ messages: hello });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after"), "60");
    await second.text();
    assert.equal(groq.requests.length, requests);

    const other = await events(await chat({ messages: hello, provider: "gemini", model: "gemini-alpha" }));
    assert.equal(other.at(-1)?.type, "done", "the other provider is unaffected");
  });
  it("an error after the stream began arrives as a final 'error' event, never as a broken response", async () => {
    await configure();
    groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')], destroyAfterStream: true });
    const res = await chat({ messages: hello });
    assert.equal(res.status, 200);
    const out = await events(res);
    assert.deepEqual(out.map((e) => e.type), ["start", "delta", "error"]);
    const last = out.at(-1) as Extract<ChatStreamEvent, { type: "error" }>;
    assert.equal(last.error.kind === "network" || last.error.kind === "provider_unavailable" || last.error.kind === "unknown", true, last.error.kind);
  });
  it("cancelling the HTTP request stops the upstream stream", async () => {
    await configure();
    groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')], holdOpen: true });
    const controller = new AbortController();
    const request = new Request(`${BASE}/api/ai/chat`, {
      method: "POST",
      headers: { host: "localhost:3000", "content-type": "application/json" },
      body: JSON.stringify({ messages: hello }),
      signal: controller.signal,
    });
    const res = await handleChat(service)(request);
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /"type":"start"/);
    await reader.cancel();
    controller.abort();
    // Reaching here without hanging is the assertion: the held-open upstream was released.
  });
  it("never puts a key into any response, including error responses", async () => {
    await configure();
    gemini.queue({ status: 400, body: JSON.stringify({ error: { code: 400, message: `API key not valid: ${GEMINI_KEY}`, status: "INVALID_ARGUMENT" } }) });
    const res = await chat({ messages: hello, provider: "gemini", model: "gemini-alpha" });
    const text = await res.text();
    seen.push(text);
    assert.equal(text.includes(GEMINI_KEY), false);
    assert.match(text, /\[redacted\]|redacted/i);
  });
});
