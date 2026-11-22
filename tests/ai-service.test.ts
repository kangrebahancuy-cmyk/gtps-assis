/**
 * The unified AiService with both providers behind it: configuration, model
 * selection, connection tests, provider switching, cooldown after rate limits.
 * Providers are the real adapters talking to local imitations of the APIs.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { AiConfigStore } from "@/server/ai/config-store";
import { AiError } from "@/server/ai/errors";
import { createGeminiProvider } from "@/server/ai/providers/gemini";
import { createGroqProvider } from "@/server/ai/providers/groq";
import { AiService } from "@/server/ai/service";
import type { ChatStreamEvent } from "@/types/ai";
import { GEMINI_KEY, geminiStream, GROQ_KEY, GROQ_RATE_HEADERS, groqStream, startFakeGemini, startFakeGroq, type Fake } from "./ai-fakes";

let gemini: Fake;
let groq: Fake;
let dir: string;
let clock: number;
let sleeps: number[];

before(async () => {
  [gemini, groq] = await Promise.all([startFakeGemini(), startFakeGroq()]);
});
after(async () => {
  await Promise.all([gemini.close(), groq.close()]);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtps-ai-"));
  clock = 1_000_000;
  sleeps = [];
  gemini.setReply(["Hel", "lo ", "wörld ✓"]);
  groq.setReply(["Hel", "lo ", "wörld ✓"]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  assert.equal(gemini.pending() + groq.pending(), 0, "an override was queued but never used");
});

const configPath = () => join(dir, "ai-config.json");

function makeService(env: Record<string, string | undefined> = {}, extra: Partial<ConstructorParameters<typeof AiService>[0]> = {}) {
  const store = new AiConfigStore(configPath(), env);
  const service = new AiService({
    store,
    providers: { gemini: createGeminiProvider(gemini.baseUrl), groq: createGroqProvider(groq.baseUrl) },
    now: () => clock,
    sleep: async (ms) => void sleeps.push(ms),
    timeoutMs: 2000,
    streamIdleMs: 2000,
    retryBackoffMs: 10,
    ...extra,
  });
  return { store, service };
}

async function run(service: AiService, request: Parameters<AiService["streamChat"]>[0]): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const e of service.streamChat(request)) events.push(e);
  return events;
}
const textOf = (events: ChatStreamEvent[]) => events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
const hello = [{ role: "user" as const, content: "hi" }];

const rejects = async (promise: Promise<unknown>, kind: string): Promise<AiError> => {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof AiError, String(e));
    assert.equal(e.kind, kind, e.message);
    return e;
  }
  throw new Error(`expected ${kind}`);
};

describe("configuration", () => {
  it("starts unconfigured and reports it", () => {
    const { service } = makeService();
    const settings = service.getSettings();
    assert.deepEqual(settings.providers.map((p) => [p.provider, p.configured, p.keySource, p.keyHint]), [["gemini", false, null, null], ["groq", false, null, null]]);
    assert.deepEqual(settings.defaults, { provider: null, model: null });
    assert.equal(settings.defaultModelListed, null);
  });
  it("saves keys to a local file with owner-only permissions, and never returns a key", async () => {
    const { service } = makeService();
    const settings = await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY } });
    assert.deepEqual(settings.providers.map((p) => [p.configured, p.keySource, p.keyHint]), [[true, "saved", `…${GEMINI_KEY.slice(-4)}`], [true, "saved", `…${GROQ_KEY.slice(-4)}`]]);
    assert.doesNotMatch(JSON.stringify(settings), new RegExp(`${GEMINI_KEY}|${GROQ_KEY}`));
    assert.ok(existsSync(configPath()));
    if (process.platform !== "win32") assert.equal(statSync(configPath()).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(configPath(), "utf8")).keys.gemini, GEMINI_KEY);
  });
  it("validates keys and saves nothing when any part is invalid", async () => {
    const { service } = makeService();
    for (const bad of ["short", "has space in it 12345", "x".repeat(600), "tab\tkey12345", "ключ-ключ-ключ"]) {
      await rejects(service.saveConfig({ keys: { gemini: bad } }), "invalid_input");
    }
    await rejects(service.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "does-not-exist" } }), "invalid_input");
    assert.equal(existsSync(configPath()), false, "nothing was written");
    assert.equal(service.getSettings().providers.every((p) => !p.configured), true);
  });
  it("uses environment keys as a fallback; a saved key wins; removal falls back to the environment key", async () => {
    const { service } = makeService({ GEMINI_API_KEY: GEMINI_KEY });
    assert.deepEqual(service.getSettings().providers[0]!.keySource, "environment");
    const other = "AIzaSyANOTHER_saved_key_0000000000000";
    await service.saveConfig({ keys: { gemini: other } });
    assert.equal(service.getSettings().providers[0]!.keySource, "saved");
    assert.equal(service.getSettings().providers[0]!.keyHint, `…${other.slice(-4)}`);
    service.removeConfig("gemini");
    assert.equal(service.getSettings().providers[0]!.keySource, "environment");
  });
  it("ignores an unusable environment key", () => {
    const { service } = makeService({ GEMINI_API_KEY: "bad key", GROQ_API_KEY: "" });
    assert.equal(service.getSettings().providers.some((p) => p.configured), false);
  });
  it("survives a corrupt config file (backs it up and starts clean)", () => {
    writeFileSync(configPath(), "{ not json");
    const { service } = makeService();
    assert.equal(service.getSettings().providers.some((p) => p.configured), false);
    assert.ok(existsSync(`${configPath()}.corrupt`));
  });
});

describe("model discovery and selection", () => {
  it("lists models per provider, caches them, and refreshes on demand", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY } });
    const first = await service.listAllModels();
    assert.deepEqual(first.map((c) => [c.provider, c.models.length, c.stale, c.error]), [["gemini", 4, false, null], ["groq", 4, false, null]]);
    const requests = gemini.requests.length + groq.requests.length;
    await service.listModels("gemini");
    await service.listModels("groq");
    assert.equal(gemini.requests.length + groq.requests.length, requests, "served from cache");
    await service.listModels("groq", { refresh: true });
    assert.equal(groq.requests.length > 0, true);
    assert.equal(service.getSettings().providers[0]!.modelCount, 4);
    clock += 11 * 60_000; // past the 10-minute cache lifetime
    const before = gemini.requests.length;
    await service.listModels("gemini");
    assert.ok(gemini.requests.length > before);
  });
  it("only lists configured providers; a failing provider does not hide the other", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY } });
    assert.deepEqual((await service.listAllModels()).map((c) => c.provider), ["groq"]);
    await service.saveConfig({ keys: { gemini: "AIzaSyBAD_KEY_000000000000000000000" } });
    const all = await service.listAllModels();
    assert.deepEqual(all.map((c) => [c.provider, c.models.length, c.error?.kind ?? null]), [["gemini", 0, "invalid_key"], ["groq", 4, null]]);
  });
  it("keeps showing the older list, marked stale, when a refresh fails", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY } });
    await service.listModels("groq");
    groq.queue({ status: 500, body: "x" });
    groq.queue({ status: 500, body: "x" });
    groq.queue({ status: 500, body: "x" });
    const catalog = await service.listModels("groq", { refresh: true });
    assert.equal(catalog.stale, true);
    assert.equal(catalog.models.length, 4);
    assert.equal(catalog.error?.kind, "provider_unavailable");
  });
  it("drops cached models when the key changes", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY } });
    await service.listModels("groq");
    await service.saveConfig({ keys: { groq: "gsk_ANOTHERwrongkey00000000000000" } });
    assert.equal(service.getSettings().providers[1]!.modelCount, null);
    await rejects(service.listModels("groq"), "invalid_key");
  });
  it("accepts only listed, chat-capable models as the default; saving is atomic", async () => {
    const { service, store } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY } });
    await rejects(service.saveConfig({ defaults: { provider: "groq", model: "missing-model" } }), "invalid_input");
    await rejects(service.saveConfig({ defaults: { provider: "groq", model: "whisper-demo" } }), "invalid_input");
    await rejects(service.saveConfig({ defaults: { provider: "groq", model: "retired-demo" } }), "invalid_input");
    await rejects(service.saveConfig({ defaults: { provider: "gemini", model: "text-embedder" } }), "invalid_input");
    assert.deepEqual(store.getDefaults(), { provider: null, model: null });
    const settings = await service.saveConfig({ defaults: { provider: "gemini", model: "gemini-alpha" } });
    assert.deepEqual(settings.defaults, { provider: "gemini", model: "gemini-alpha" });
    assert.equal(settings.defaultModelListed, true);
    await rejects(service.saveConfig({ defaults: { provider: "groq", model: "" as string } }), "invalid_input");
  });
  it("needs a key before a default can be chosen, and flags a default that later disappears from the list", async () => {
    const { service } = makeService();
    await rejects(service.saveConfig({ defaults: { provider: "gemini", model: "gemini-alpha" } }), "not_configured");
    await service.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue({ status: 200, body: JSON.stringify({ data: [{ id: "something-else" }] }) });
    await service.listModels("groq", { refresh: true });
    assert.equal(service.getSettings().defaultModelListed, false);
  });
  it("removing a provider clears defaults that pointed at it", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY, gemini: GEMINI_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    service.removeConfig("gemini");
    assert.equal(service.getSettings().defaults.provider, "groq");
    const after = service.removeConfig("groq");
    assert.deepEqual(after.defaults, { provider: null, model: null });
    assert.equal(after.providers.some((p) => p.configured), false);
  });
});

describe("connection tests", () => {
  it("tests a candidate key without saving it", async () => {
    const { service } = makeService();
    const ok = await service.testConnection("gemini", { apiKey: GEMINI_KEY });
    assert.deepEqual([ok.ok, ok.scope, ok.modelCount, ok.error], [true, "key", 4, null]);
    assert.equal(typeof ok.latencyMs, "number");
    assert.equal(existsSync(configPath()), false);
    assert.equal(service.getSettings().providers[0]!.configured, false);
    const bad = await service.testConnection("groq", { apiKey: "gsk_NOPE_NOPE_NOPE_00000000000000" });
    assert.deepEqual([bad.ok, bad.error?.kind, bad.error?.status], [false, "invalid_key", 401]);
    assert.doesNotMatch(JSON.stringify(bad), /gsk_NOPE/);
  });
  it("rejects a malformed candidate key before any request, and reports a missing key", async () => {
    const { service } = makeService();
    const before = gemini.requests.length;
    assert.equal((await service.testConnection("gemini", { apiKey: "short" })).error?.kind, "invalid_input");
    assert.equal(gemini.requests.length, before);
    assert.equal((await service.testConnection("groq")).error?.kind, "not_configured");
  });
  it("tests the saved key, and with scope 'model' also runs a tiny generation", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY } });
    const before = groq.requests.filter((r) => r.url === "/chat/completions").length;
    const result = await service.testConnection("groq", { scope: "model", model: "llama-demo-70b" });
    assert.deepEqual([result.ok, result.testedModel], [true, "llama-demo-70b"]);
    assert.equal(groq.requests.filter((r) => r.url === "/chat/completions").length - before, 1);
    const auto = await service.testConnection("groq", { scope: "model" });
    assert.equal(auto.testedModel, "llama-demo-70b", "first chat-capable model when none is chosen");
  });
  it("reports a failing model test with its error, and ignores the local cooldown", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY } });
    groq.queue({ status: 404, body: JSON.stringify({ error: { message: "model gone", code: "model_not_found" } }) });
    const result = await service.testConnection("groq", { scope: "model", model: "gone-model" });
    assert.deepEqual([result.ok, result.error?.kind], [false, "model_not_found"]);
  });
});

describe("chat and provider switching", () => {
  it("uses the saved default provider and model", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } });
    gemini.setReply(["from ", "gemini"]);
    const events = await run(service, { messages: hello });
    assert.deepEqual(events[0], { type: "start", provider: "gemini", model: "gemini-alpha" });
    assert.equal(textOf(events), "from gemini");
    assert.deepEqual(events.at(-1), { type: "done", finishReason: "stop" });
    assert.match(gemini.requests.at(-1)!.url, /^\/models\/gemini-alpha:streamGenerateContent/);
  });
  it("switches provider by changing the default, with the same request and the same event shape", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } });
    gemini.setReply(["G"]);
    groq.setReply(["Q"]);
    const viaGemini = await run(service, { messages: hello });
    await service.saveConfig({ defaults: { provider: "groq", model: "llama-demo-70b" } });
    const viaGroq = await run(service, { messages: hello });
    assert.deepEqual(viaGemini.map((e) => e.type), viaGroq.map((e) => e.type));
    assert.deepEqual([textOf(viaGemini), textOf(viaGroq)], ["G", "Q"]);
    assert.equal((viaGroq[0] as { provider: string }).provider, "groq");
  });
  it("lets a single request override the default provider and model", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } });
    const before = groq.requests.length;
    const events = await run(service, { provider: "groq", model: "qwen-coder-demo", messages: hello });
    assert.deepEqual(events[0], { type: "start", provider: "groq", model: "qwen-coder-demo" });
    assert.equal(groq.requests.length - before, 1);
    assert.equal(JSON.parse(groq.requests.at(-1)!.body).model, "qwen-coder-demo");
  });
  it("a default model of one provider is not applied to another", () => {
    const { service } = makeService();
    return service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } }).then(async () => {
      await rejects(run(service, { provider: "groq", messages: hello }), "not_configured");
    });
  });
  it("explains what is missing: no default, no model, no key", async () => {
    const { service } = makeService();
    assert.match((await rejects(run(service, { messages: hello }), "not_configured")).message, /No AI provider is selected/);
    await rejects(run(service, { provider: "groq", model: "m", messages: hello }), "not_configured");
    assert.equal(service.resolveTarget({ provider: "groq", model: "m" }).model, "m");
  });
  it("generateText collects a whole reply from either provider", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.setReply(["one ", "two"]);
    assert.deepEqual(await service.generateText({ messages: hello }), { provider: "groq", model: "llama-demo-70b", text: "one two", finishReason: "stop" });
  });
  it("one provider failing does not affect the other", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } });
    gemini.queue({ status: 403, body: JSON.stringify({ error: { message: "denied", status: "PERMISSION_DENIED" } }) });
    await rejects(run(service, { messages: hello }), "permission_denied");
    assert.equal(textOf(await run(service, { provider: "groq", model: "llama-demo-70b", messages: hello })), "Hello wörld ✓");
  });
});

describe("rate limits: cooldown and quota", () => {
  const limited = (retryAfter?: string) => ({
    status: 429,
    headers: { ...GROQ_RATE_HEADERS, "x-ratelimit-remaining-requests": "0", ...(retryAfter ? { "retry-after": retryAfter } : {}) },
    body: JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }),
  });

  it("after a long rate limit, further chat requests fail fast locally (no network) until the cooldown ends", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue(limited("90"));
    const first = await rejects(run(service, { messages: hello }), "rate_limited");
    assert.equal(first.retryAfterMs, 90_000);
    assert.deepEqual(sleeps, [], "90 s is longer than we are willing to wait inline");

    const network = groq.requests.length;
    clock += 30_000;
    const blocked = await rejects(run(service, { messages: hello }), "rate_limited");
    assert.equal(groq.requests.length, network, "no request was sent during the cooldown");
    assert.equal(blocked.retryAfterMs, 60_000);
    assert.match(blocked.message, /paused locally/);
    const status = service.getSettings().providers[1]!;
    assert.equal(status.cooldownUntil, new Date(clock + 60_000).toISOString());
    assert.equal(status.rateLimit?.requests?.remaining, 0, "actual remaining quota comes from the provider's headers");

    clock += 61_000;
    assert.equal(textOf(await run(service, { messages: hello })), "Hello wörld ✓");
    assert.equal(service.getSettings().providers[1]!.cooldownUntil, null);
  });
  it("a manual connection test and a model refresh are not blocked by the cooldown", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue(limited("90"));
    await rejects(run(service, { messages: hello }), "rate_limited");
    assert.equal((await service.testConnection("groq")).ok, true);
    assert.equal((await service.listModels("groq", { refresh: true })).error, null);
  });
  it("uses a short default cooldown when the provider does not say how long, capped by maxCooldownMs", async () => {
    const { service } = makeService({}, { defaultCooldownMs: 5000, maxCooldownMs: 20_000, maxRetries: 0 });
    await service.saveConfig({ keys: { groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue({ status: 429, body: "{}" });
    await rejects(run(service, { messages: hello }), "rate_limited");
    assert.equal((await rejects(run(service, { messages: hello }), "rate_limited")).retryAfterMs, 5000);
    clock += 6000;
    groq.queue(limited("7200"));
    await rejects(run(service, { messages: hello }), "rate_limited");
    assert.equal((await rejects(run(service, { messages: hello }), "rate_limited")).retryAfterMs, 20_000, "capped");
  });
  it("a cooldown on one provider does not stop the other", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue(limited("90"));
    await rejects(run(service, { messages: hello }), "rate_limited");
    assert.equal(textOf(await run(service, { provider: "gemini", model: "gemini-alpha", messages: hello })), "Hello wörld ✓");
  });
  it("a short rate limit is waited out inline and the request succeeds", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY }, defaults: { provider: "gemini", model: "gemini-alpha" } });
    gemini.queue({ status: 429, body: JSON.stringify({ error: { message: "slow down", status: "RESOURCE_EXHAUSTED", details: [{ retryDelay: "2s" }] } }) });
    assert.equal(textOf(await run(service, { messages: hello })), "Hello wörld ✓");
    assert.deepEqual(sleeps, [2000]);
    assert.equal(service.getSettings().providers[0]!.cooldownUntil, null);
    assert.equal(service.getSettings().providers[0]!.rateLimit, null, "Gemini reports no remaining quota; none is invented");
  });
  it("does not report free tier or invent remaining quota for any model", async () => {
    const { service } = makeService();
    await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY } });
    const catalogs = await service.listAllModels();
    assert.ok(catalogs.every((c) => c.models.every((m) => m.freeTier === "unverified")));
    const gem = service.getSettings().providers[0]!;
    assert.match(gem.quotaNote, /does not report remaining quota/);
    assert.equal(geminiStream(["x"]).length > 0 && groqStream(["x"]).length > 0, true);
  });
});
