/** Google Gemini adapter, tested on its own against a local imitation of the API (see ai-fakes.ts). */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { AiError } from "@/server/ai/errors";
import { createGeminiProvider, parseGeminiError } from "@/server/ai/providers/gemini";
import { GEMINI_KEY, geminiStream, startFakeGemini, type Fake } from "./ai-fakes";
import { collect, rig, textOf } from "./ai-helpers";

let fake: Fake;
let provider: ReturnType<typeof createGeminiProvider>;
before(async () => {
  fake = await startFakeGemini();
  provider = createGeminiProvider(fake.baseUrl);
});
after(() => fake.close());
afterEach(() => assert.equal(fake.pending(), 0, "an override was queued but never used"));

const failure = async (run: () => Promise<unknown>): Promise<AiError> => {
  try {
    await run();
  } catch (e) {
    assert.ok(e instanceof AiError, `expected AiError, got ${String(e)}`);
    return e;
  }
  throw new Error("expected a failure");
};

describe("Gemini: model discovery", () => {
  it("lists models across pages and normalises them", async () => {
    const before = fake.requests.length;
    const models = await provider.listModels(rig(GEMINI_KEY).ctx);
    assert.deepEqual(models.map((m) => m.id), ["gemini-alpha", "gemini-beta-flash", "text-embedder", "codegemma-demo"]);
    assert.equal(fake.requests.length - before, 2, "followed nextPageToken");
    const alpha = models[0]!;
    assert.deepEqual([alpha.provider, alpha.name, alpha.contextWindow, alpha.maxOutputTokens, alpha.availability], ["gemini", "Gemini Alpha", 1048576, 65536, "available"]);
    assert.equal(alpha.description, "General model");
  });
  it("marks non-generation models as not chat, code-named models as specialized, and never claims free tier", async () => {
    const models = await provider.listModels(rig(GEMINI_KEY).ctx);
    const embedder = models.find((m) => m.id === "text-embedder")!;
    assert.equal(embedder.availability, "not_chat");
    assert.match(embedder.availabilityNote ?? "", /generateContent/);
    assert.equal(models.find((m) => m.id === "codegemma-demo")?.coding, "specialized");
    assert.equal(models.find((m) => m.id === "gemini-alpha")?.coding, "unknown");
    assert.ok(models.every((m) => m.freeTier === "unverified"));
  });
  it("sends the key in a header, never in the URL", async () => {
    await provider.listModels(rig(GEMINI_KEY).ctx);
    const last = fake.requests.slice(-2);
    for (const r of last) {
      assert.equal(r.headers["x-goog-api-key"], GEMINI_KEY);
      assert.ok(!r.url.includes(GEMINI_KEY) && !r.url.includes("key="));
    }
  });
});

describe("Gemini: API key validation", () => {
  it("an invalid key is reported as invalid_key, not retried, and the message never contains the key", async () => {
    const bad = "AIzaSyTHIS_IS_NOT_A_VALID_KEY_000000000";
    const t = rig(bad);
    const before = fake.requests.length;
    const error = await failure(() => provider.listModels(t.ctx));
    assert.equal(error.kind, "invalid_key");
    assert.equal(error.retryable, false);
    assert.equal(error.status, 400);
    assert.equal(fake.requests.length - before, 1, "no retry for a rejected key");
    assert.doesNotMatch(error.message, new RegExp(bad));
    assert.match(error.message, /Google Gemini rejected the API key/);
    assert.deepEqual(t.sleeps, []);
  });
});

describe("Gemini: streaming", () => {
  it("streams text deltas (multi-byte characters intact across tiny chunks), usage and a stop", async () => {
    fake.setReply(["Hel", "lo ", "wörld ✓ 日本"]);
    const events = await collect(provider, rig(GEMINI_KEY).ctx);
    assert.equal(textOf(events), "Hello wörld ✓ 日本");
    assert.deepEqual(events.at(-2), { type: "usage", inputTokens: 5, outputTokens: 3, totalTokens: 8 });
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
    assert.equal(events.filter((e) => e.type === "delta").length, 3, "one delta per streamed chunk");
  });
  it("builds the request: model in the path, roles mapped, system prompt separated, limits passed", async () => {
    await collect(provider, rig(GEMINI_KEY).ctx, {
      model: "gemini-alpha",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Q1" }, { role: "assistant", content: "A1" }, { role: "user", content: "Q2" }],
      temperature: 0.3,
      maxOutputTokens: 200,
    });
    const req = fake.requests.at(-1)!;
    assert.equal(req.url, "/models/gemini-alpha:streamGenerateContent?alt=sse");
    assert.equal(req.headers["x-goog-api-key"], GEMINI_KEY);
    const body = JSON.parse(req.body);
    assert.deepEqual(body.contents.map((c: { role: string }) => c.role), ["user", "model", "user"]);
    assert.deepEqual(body.systemInstruction, { parts: [{ text: "Be brief." }] });
    assert.deepEqual(body.generationConfig, { temperature: 0.3, maxOutputTokens: 200 });
  });
  it("maps finish reasons: MAX_TOKENS -> length, SAFETY -> blocked", async () => {
    fake.queue({ stream: geminiStream(["partial"], "MAX_TOKENS") });
    assert.deepEqual((await collect(provider, rig(GEMINI_KEY).ctx)).at(-1), { type: "done", finishReason: "length" });
    fake.queue({ stream: geminiStream(["x"], "SAFETY") });
    assert.deepEqual((await collect(provider, rig(GEMINI_KEY).ctx)).at(-1), { type: "done", finishReason: "blocked" });
  });
  it("skips reasoning ('thought') parts and parts without text", async () => {
    const chunk = { candidates: [{ content: { parts: [{ text: "thinking...", thought: true }, { thoughtSignature: "abc" }, { text: "answer" }] }, finishReason: "STOP" }] };
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify(chunk)}\n\n`)] });
    assert.equal(textOf(await collect(provider, rig(GEMINI_KEY).ctx)), "answer");
  });
  it("turns a blocked prompt into content_blocked", async () => {
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`)] });
    const error = await failure(() => collect(provider, rig(GEMINI_KEY).ctx));
    assert.equal(error.kind, "content_blocked");
  });
  it("reports an error event inside the stream and a stream that ends without finishing", async () => {
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "a" }] } }] })}\n\n`), Buffer.from(`data: ${JSON.stringify({ error: { code: 503, message: "overloaded" } })}\n\n`)] });
    assert.equal((await failure(() => collect(provider, rig(GEMINI_KEY).ctx))).kind, "provider_unavailable");
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "a" }] } }] })}\n\n`)] });
    const truncated = await failure(() => collect(provider, rig(GEMINI_KEY).ctx));
    assert.match(truncated.message, /ended the stream without finishing/);
  });
  it("a dropped connection mid-stream is a retryable network error, and text received so far was delivered", async () => {
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "part" }] } }] })}\n\n`)], destroyAfterStream: true });
    const got: string[] = [];
    const error = await failure(async () => {
      for await (const e of provider.streamChat(rig(GEMINI_KEY).ctx, { model: "m", messages: [{ role: "user", content: "hi" }] })) if (e.type === "delta") got.push(e.text);
    });
    assert.deepEqual(got, ["part"]);
    assert.equal(error.kind === "network" || error.kind === "provider_unavailable", true);
    assert.equal(error.retryable, true);
  });
  it("cancelling stops the stream with kind cancelled", async () => {
    const controller = new AbortController();
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "a" }] } }] })}\n\n`)], holdOpen: true });
    const error = await failure(async () => {
      for await (const e of provider.streamChat(rig(GEMINI_KEY, { signal: controller.signal }).ctx, { model: "m", messages: [{ role: "user", content: "hi" }] })) {
        if (e.type === "delta") controller.abort();
      }
    });
    assert.equal(error.kind, "cancelled");
  });
  it("stops with kind timeout when a stream goes silent", async () => {
    fake.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "a" }] } }] })}\n\n`)], holdOpen: true });
    const got: string[] = [];
    const error = await failure(async () => {
      for await (const e of provider.streamChat(rig(GEMINI_KEY, { streamIdleMs: 80 }).ctx, { model: "m", messages: [{ role: "user", content: "hi" }] })) {
        if (e.type === "delta") got.push(e.text);
      }
    });
    assert.deepEqual(got, ["a"]);
    assert.equal(error.kind, "timeout");
    assert.equal(error.retryable, true);
  });
});

describe("Gemini: rate limits and server errors", () => {
  const rateLimited = (retryDelay?: string) => ({
    status: 429,
    body: JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED", details: retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : [] } }),
  });

  it("waits for the announced retryDelay and then succeeds", async () => {
    fake.queue(rateLimited("2s"));
    const t = rig(GEMINI_KEY);
    const events = await collect(provider, t.ctx);
    assert.deepEqual(t.sleeps, [2000]);
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
  });
  it("honours the Retry-After header too", async () => {
    fake.queue({ ...rateLimited(), headers: { "retry-after": "3" } });
    const t = rig(GEMINI_KEY);
    await provider.listModels(t.ctx);
    assert.deepEqual(t.sleeps, [3000]);
  });
  it("does not wait when the provider asks for longer than the cap; the error carries retryAfterMs", async () => {
    fake.queue(rateLimited("120s"));
    const t = rig(GEMINI_KEY, { maxRetryWaitMs: 10_000 });
    const before = fake.requests.length;
    const error = await failure(() => provider.listModels(t.ctx));
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterMs, 120_000);
    assert.equal(error.retryable, true);
    assert.deepEqual(t.sleeps, []);
    assert.equal(fake.requests.length - before, 1);
  });
  it("gives up after maxRetries with exponential backoff when the provider gives no delay", async () => {
    fake.queue(rateLimited());
    fake.queue(rateLimited());
    fake.queue(rateLimited());
    const t = rig(GEMINI_KEY, { maxRetries: 2, retryBackoffMs: 100 });
    const error = await failure(() => provider.listModels(t.ctx));
    assert.equal(error.kind, "rate_limited");
    assert.deepEqual(t.sleeps, [100, 200]);
  });
  it("retries 503 and succeeds; reports 500s that persist as provider_unavailable", async () => {
    fake.queue({ status: 503, body: JSON.stringify({ error: { code: 503, message: "The model is overloaded.", status: "UNAVAILABLE" } }) });
    const t = rig(GEMINI_KEY);
    assert.equal((await provider.listModels(t.ctx)).length, 4);
    assert.equal(t.sleeps.length, 1);
    for (let i = 0; i < 3; i++) fake.queue({ status: 500, body: "boom" });
    const error = await failure(() => provider.listModels(rig(GEMINI_KEY).ctx));
    assert.equal(error.kind, "provider_unavailable");
  });
  it("maps 403 to permission_denied and 404 to model_not_found without retrying", async () => {
    fake.queue({ status: 403, body: JSON.stringify({ error: { code: 403, message: "Permission denied.", status: "PERMISSION_DENIED" } }) });
    assert.equal((await failure(() => provider.listModels(rig(GEMINI_KEY).ctx))).kind, "permission_denied");
    fake.queue({ status: 404, body: JSON.stringify({ error: { code: 404, message: "models/nope is not found", status: "NOT_FOUND" } }) });
    const nf = await failure(() => collect(provider, rig(GEMINI_KEY).ctx, { model: "nope" }));
    assert.equal(nf.kind, "model_not_found");
    assert.match(nf.message, /nope/);
  });
  it("times out when the server never answers, and reports a network error when it is unreachable", async () => {
    fake.queue({ hang: true });
    const timeout = await failure(() => provider.listModels(rig(GEMINI_KEY, { timeoutMs: 80, maxRetries: 0 }).ctx));
    assert.equal(timeout.kind, "timeout");
    const dead = createGeminiProvider("http://127.0.0.1:1");
    const net = await failure(() => dead.listModels(rig(GEMINI_KEY, { maxRetries: 0 }).ctx));
    assert.equal(net.kind, "network");
    assert.doesNotMatch(net.message, new RegExp(GEMINI_KEY));
  });
});

describe("parseGeminiError", () => {
  it("reads message, status code and retryDelay, and tolerates non-JSON bodies", () => {
    assert.deepEqual(parseGeminiError(JSON.stringify({ error: { message: "m", status: "S", details: [{ retryDelay: "33s" }] } })), { message: "m", code: "S", retryAfterMs: 33_000 });
    assert.deepEqual(parseGeminiError("<html>bad gateway</html>"), { message: "<html>bad gateway</html>", code: null, retryAfterMs: null });
    assert.deepEqual(parseGeminiError(""), { message: null, code: null, retryAfterMs: null });
  });
});
