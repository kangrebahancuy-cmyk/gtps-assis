/** Groq adapter, tested on its own against a local imitation of the API (see ai-fakes.ts). */
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";

import { AiError } from "@/server/ai/errors";
import { createGroqProvider, parseGroqError } from "@/server/ai/providers/groq";
import { GROQ_KEY, GROQ_RATE_HEADERS, groqStream, startFakeGroq, type Fake } from "./ai-fakes";
import { collect, rig, textOf } from "./ai-helpers";

let fake: Fake;
let provider: ReturnType<typeof createGroqProvider>;
before(async () => {
  fake = await startFakeGroq();
  provider = createGroqProvider(fake.baseUrl);
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

describe("Groq: model discovery", () => {
  it("lists models with context window, output limit and owner", async () => {
    const models = await provider.listModels(rig(GROQ_KEY).ctx);
    assert.deepEqual(models.map((m) => m.id), ["llama-demo-70b", "qwen-coder-demo", "whisper-demo", "retired-demo"]);
    const llama = models[0]!;
    assert.deepEqual([llama.provider, llama.name, llama.contextWindow, llama.maxOutputTokens, llama.availability], ["groq", "llama-demo-70b", 131072, 32768, "available"]);
    assert.equal(llama.description, "Provided by Meta");
    assert.equal(models[1]!.maxOutputTokens, null, "a field the provider omits stays unknown");
  });
  it("flags inactive and non-chat models, code-named models, and never claims free tier", async () => {
    const models = await provider.listModels(rig(GROQ_KEY).ctx);
    assert.equal(models.find((m) => m.id === "retired-demo")?.availability, "inactive");
    const whisper = models.find((m) => m.id === "whisper-demo")!;
    assert.equal(whisper.availability, "not_chat");
    assert.match(whisper.availabilityNote ?? "", /guessed from its id/);
    assert.equal(models.find((m) => m.id === "qwen-coder-demo")?.coding, "specialized");
    assert.ok(models.every((m) => m.freeTier === "unverified"));
  });
  it("tolerates models with missing fields and drops entries without an id", async () => {
    fake.queue({ status: 200, body: JSON.stringify({ data: [{ id: "bare" }, { object: "model" }, "junk", null] }) });
    const models = await provider.listModels(rig(GROQ_KEY).ctx);
    assert.deepEqual(models.map((m) => [m.id, m.contextWindow, m.availability]), [["bare", null, "available"]]);
  });
  it("rejects an unexpected response shape as a retryable provider error", async () => {
    fake.queue({ status: 200, body: JSON.stringify({ nope: true }) });
    const error = await failure(() => provider.listModels(rig(GROQ_KEY).ctx));
    assert.equal(error.kind, "provider_unavailable");
    assert.equal(error.retryable, true);
  });
  it("sends the key as a Bearer header and reports rate-limit headers it saw", async () => {
    const t = rig(GROQ_KEY);
    await provider.listModels(t.ctx);
    assert.equal(fake.requests.at(-1)!.headers.authorization, `Bearer ${GROQ_KEY}`);
    assert.ok(!fake.requests.at(-1)!.url.includes(GROQ_KEY));
    const snapshot = t.rateLimits.at(-1)!;
    assert.deepEqual(snapshot.requests, { limit: 14400, remaining: 14370, resetsIn: "2m59.56s" });
    assert.deepEqual(snapshot.tokens, { limit: 18000, remaining: 17997, resetsIn: "7.66s" });
    assert.match(snapshot.observedAt, /^\d{4}-/);
  });
});

describe("Groq: API key validation", () => {
  it("an invalid key is invalid_key (401), not retried, and its text never appears in the error", async () => {
    const bad = "gsk_THISKEYISWRONG0000000000000";
    const t = rig(bad);
    const before = fake.requests.length;
    const error = await failure(() => provider.listModels(t.ctx));
    assert.equal(error.kind, "invalid_key");
    assert.equal(error.status, 401);
    assert.equal(error.retryable, false);
    assert.equal(fake.requests.length - before, 1);
    assert.doesNotMatch(error.message, new RegExp(bad));
    assert.match(error.message, /Groq rejected the API key: Invalid API Key/);
  });
});

describe("Groq: streaming", () => {
  it("streams OpenAI-style deltas through [DONE], with usage, across tiny byte chunks", async () => {
    fake.setReply(["Hel", "lo ", "wörld ✓ 日本"]);
    const events = await collect(provider, rig(GROQ_KEY).ctx, { model: "llama-demo-70b" });
    assert.equal(textOf(events), "Hello wörld ✓ 日本");
    assert.deepEqual(events.at(-2), { type: "usage", inputTokens: 4, outputTokens: 3, totalTokens: 7 });
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
  });
  it("builds the request: stream flag, messages as given, limits passed", async () => {
    await collect(provider, rig(GROQ_KEY).ctx, {
      model: "llama-demo-70b",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Q" }],
      temperature: 0.2,
      maxOutputTokens: 50,
    });
    const req = fake.requests.at(-1)!;
    assert.equal(req.url, "/chat/completions");
    assert.deepEqual(JSON.parse(req.body), {
      model: "llama-demo-70b",
      messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "Q" }],
      stream: true,
      temperature: 0.2,
      max_completion_tokens: 50,
    });
  });
  it("maps finish reasons: length and content_filter", async () => {
    fake.queue({ stream: groqStream(["cut"], "length", false) });
    assert.deepEqual((await collect(provider, rig(GROQ_KEY).ctx)).at(-1), { type: "done", finishReason: "length" });
    fake.queue({ stream: groqStream(["x"], "content_filter", false) });
    assert.deepEqual((await collect(provider, rig(GROQ_KEY).ctx)).at(-1), { type: "done", finishReason: "blocked" });
  });
  it("reports an error event inside the stream, and a stream that ends with no finish and no [DONE]", async () => {
    fake.queue({ stream: [Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'), Buffer.from('data: {"error":{"message":"model overloaded","type":"server_error"}}\n\n')] });
    assert.equal((await failure(() => collect(provider, rig(GROQ_KEY).ctx))).kind, "provider_unavailable");
    fake.queue({ stream: [Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n')] });
    assert.match((await failure(() => collect(provider, rig(GROQ_KEY).ctx))).message, /without finishing/);
  });
  it("ignores keep-alive comments and malformed lines", async () => {
    fake.queue({ stream: [Buffer.from(': ping\n\ndata: not json\n\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')] });
    assert.equal(textOf(await collect(provider, rig(GROQ_KEY).ctx)), "ok");
  });
  it("cancelling stops the stream; a silent stream times out", async () => {
    const controller = new AbortController();
    const first = Buffer.from('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    fake.queue({ stream: [first], holdOpen: true });
    const cancelled = await failure(async () => {
      for await (const e of provider.streamChat(rig(GROQ_KEY, { signal: controller.signal }).ctx, { model: "m", messages: [{ role: "user", content: "hi" }] })) if (e.type === "delta") controller.abort();
    });
    assert.equal(cancelled.kind, "cancelled");
    fake.queue({ stream: [first], holdOpen: true });
    const silent = await failure(() => collect(provider, rig(GROQ_KEY, { streamIdleMs: 80 }).ctx));
    assert.equal(silent.kind, "timeout");
  });
});

describe("Groq: rate limits and errors", () => {
  const tooMany = (headers: Record<string, string> = {}) => ({
    status: 429,
    headers: { ...GROQ_RATE_HEADERS, "x-ratelimit-remaining-requests": "0", ...headers },
    body: JSON.stringify({ error: { message: "Rate limit reached for model in organization on requests per day (RPD): Limit 1000, Used 1000.", type: "requests", code: "rate_limit_exceeded" } }),
  });

  it("waits for Retry-After (seconds) and then succeeds; the quota headers of the 429 are still recorded", async () => {
    fake.queue(tooMany({ "retry-after": "2" }));
    const t = rig(GROQ_KEY);
    const models = await provider.listModels(t.ctx);
    assert.equal(models.length, 4);
    assert.deepEqual(t.sleeps, [2000]);
    assert.equal(t.rateLimits[0]?.requests?.remaining, 0);
  });
  it("does not wait for a long Retry-After; the error carries it", async () => {
    fake.queue(tooMany({ "retry-after": "3600" }));
    const t = rig(GROQ_KEY);
    const error = await failure(() => collect(provider, t.ctx));
    assert.equal(error.kind, "rate_limited");
    assert.equal(error.retryAfterMs, 3_600_000);
    assert.deepEqual(t.sleeps, []);
    assert.match(error.message, /Groq rate limit reached: Rate limit reached for model/);
  });
  it("backs off exponentially when there is no Retry-After, then gives up", async () => {
    for (let i = 0; i < 3; i++) fake.queue({ ...tooMany(), headers: {} });
    const t = rig(GROQ_KEY, { retryBackoffMs: 50 });
    const error = await failure(() => provider.listModels(t.ctx));
    assert.equal(error.kind, "rate_limited");
    assert.deepEqual(t.sleeps, [50, 100]);
  });
  it("retries 5xx, maps 404 to model_not_found and 400 to bad_request without retrying", async () => {
    fake.queue({ status: 502, body: "bad gateway" });
    const t = rig(GROQ_KEY);
    assert.equal((await provider.listModels(t.ctx)).length, 4);
    assert.equal(t.sleeps.length, 1);
    fake.queue({ status: 404, body: JSON.stringify({ error: { message: "The model `nope` does not exist", type: "invalid_request_error", code: "model_not_found" } }) });
    assert.equal((await failure(() => collect(provider, rig(GROQ_KEY).ctx, { model: "nope" }))).kind, "model_not_found");
    fake.queue({ status: 400, body: JSON.stringify({ error: { message: "messages must not be empty", type: "invalid_request_error" } }) });
    const bad = await failure(() => collect(provider, rig(GROQ_KEY).ctx));
    assert.equal(bad.kind, "bad_request");
    assert.equal(bad.retryable, false);
  });
  it("times out on a server that never answers; reports unreachable hosts as network errors", async () => {
    fake.queue({ hang: true });
    assert.equal((await failure(() => provider.listModels(rig(GROQ_KEY, { timeoutMs: 80, maxRetries: 0 }).ctx))).kind, "timeout");
    const net = await failure(() => createGroqProvider("http://127.0.0.1:1").listModels(rig(GROQ_KEY, { maxRetries: 0 }).ctx));
    assert.equal(net.kind, "network");
  });
  it("redacts anything key-shaped that a provider echoes back", async () => {
    fake.queue({ status: 400, body: JSON.stringify({ error: { message: `Bad request for key ${GROQ_KEY} and Bearer abcdefghijklmnop123456` } }) });
    const error = await failure(() => collect(provider, rig(GROQ_KEY).ctx));
    assert.doesNotMatch(error.message, /gsk_|abcdefghijklmnop123456/);
    assert.match(error.message, /\[redacted\]/);
  });
});

describe("parseGroqError", () => {
  it("reads message and code, and tolerates plain-text bodies", () => {
    assert.deepEqual(parseGroqError(JSON.stringify({ error: { message: "m", code: "c", type: "t" } })), { message: "m", code: "c", retryAfterMs: null });
    assert.deepEqual(parseGroqError("upstream down"), { message: "upstream down", code: null, retryAfterMs: null });
  });
});
