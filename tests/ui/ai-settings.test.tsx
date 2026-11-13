/**
 * Server-side render tests for the AI settings views, fed with data produced by
 * the real AiService against local fake providers. They check structure and
 * wording (never a key, free tier never claimed), not clicks or styling.
 * Run with `npm run test:ui`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AiModelsView, type AiModelsViewProps } from "@/features/settings/ai/ai-models-view";
import { AiProvidersView, type AiProvidersViewProps } from "@/features/settings/ai/ai-providers-view";
import { AiConfigStore } from "@/server/ai/config-store";
import { createGeminiProvider } from "@/server/ai/providers/gemini";
import { createGroqProvider } from "@/server/ai/providers/groq";
import { AiService } from "@/server/ai/service";
import { errorHint, formatDuration, formatFreeTier, formatTokens } from "@/lib/ai-format";
import type { AiSettingsView, ConnectionTestResult, ModelCatalog } from "@/types/ai";
import { GEMINI_KEY, GROQ_KEY, GROQ_RATE_HEADERS, startFakeGemini, startFakeGroq, type Fake } from "../ai-fakes";

(globalThis as { React?: unknown }).React = React;

let gemini: Fake;
let groq: Fake;
let dir: string;
let service: AiService;
let clock = 9_000_000;

before(async () => {
  [gemini, groq] = await Promise.all([startFakeGemini(), startFakeGroq()]);
  dir = mkdtempSync(join(tmpdir(), "gtps-ui-"));
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
after(async () => {
  await Promise.all([gemini.close(), groq.close()]);
  rmSync(dir, { recursive: true, force: true });
});

const noop = () => {};
const drafts = { gemini: "", groq: "" };

const providersProps = (settings: AiSettingsView, extra: Partial<AiProvidersViewProps> = {}): AiProvidersViewProps => ({
  providers: settings.providers, keyDrafts: drafts, tests: {}, busy: null, notice: null, now: clock,
  onKeyChange: noop, onTest: noop, onSave: noop, onRemove: noop, onRemoveAll: noop, ...extra,
});
const modelsProps = (settings: AiSettingsView, catalogs: ModelCatalog[], extra: Partial<AiModelsViewProps> = {}): AiModelsViewProps => ({
  settings, catalogs, defaultDraft: settings.defaults, busy: null, notice: null, filter: null, showUnusable: false,
  onFilter: noop, onShowUnusable: noop, onDefaultProvider: noop, onDefaultModel: noop, onPick: noop, onSave: noop, onRefresh: noop, ...extra,
});
const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("providers view", () => {
  it("shows both providers as not configured, with password inputs and nothing to test", () => {
    const out = html(<AiProvidersView {...providersProps(service.getSettings())} />);
    assert.match(out, /Google Gemini/);
    assert.match(out, /Groq/);
    assert.equal((out.match(/Not configured/g) ?? []).length, 2);
    assert.equal((out.match(/type="password"/g) ?? []).length, 2);
    assert.match(out, /autoComplete="off"|autocomplete="off"/);
    assert.match(out, /No quota reported yet/);
    assert.match(out, /disabled=""[^>]*>Test connection/);
  });
  it("after saving, shows a key hint but never the key", async () => {
    const settings = await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY } });
    const out = html(<AiProvidersView {...providersProps(settings)} />);
    assert.match(out, new RegExp(`Key saved …${GEMINI_KEY.slice(-4)}`));
    assert.equal(out.includes(GEMINI_KEY) || out.includes(GROQ_KEY), false);
    assert.doesNotMatch(out, /value="[^"]+"/, "key fields render empty");
  });
  it("never claims free-tier eligibility and says what quota information is and is not", () => {
    const out = html(<AiProvidersView {...providersProps(service.getSettings())} />);
    assert.match(out, /Free-tier eligibility is not verified/);
    assert.doesNotMatch(out, /Free tier \(verified\)|unlimited/i);
    assert.match(out, /does not report remaining quota|not report/i);
  });
  it("shows a connection test success and failure", async () => {
    const ok = await service.testConnection("gemini");
    const bad = await service.testConnection("groq", { apiKey: "gsk_NOPE_NOPE_NOPE_00000000000000" });
    const out = html(<AiProvidersView {...providersProps(service.getSettings(), { tests: { gemini: ok, groq: bad } })} />);
    assert.match(out, /Connected\. 4 models found\./);
    assert.match(out, /role="alert"[^>]*>[^<]*(Invalid API Key|invalid)[^<]*Check that the key is complete/i);
    assert.equal(out.includes("gsk_NOPE"), false);
  });
  it("shows observed quota from the provider and a cooldown notice, labelled as observed", async () => {
    await service.saveConfig({ defaults: { provider: "groq", model: "llama-demo-70b" } });
    groq.queue({ status: 429, headers: { ...GROQ_RATE_HEADERS, "retry-after": "90", "x-ratelimit-remaining-requests": "0" }, body: JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }) });
    await assert.rejects(async () => { for await (const _ of service.streamChat({ messages: [{ role: "user", content: "hi" }] })) void _; });
    const out = html(<AiProvidersView {...providersProps(service.getSettings())} />);
    assert.match(out, /Requests: 0 of 14400 remaining/);
    assert.match(out, /not a prediction/);
    assert.match(out, /Rate limit reached\. Chat requests to Groq are paused for about 1 min 30 s/);
    clock += 100_000;
    assert.doesNotMatch(html(<AiProvidersView {...providersProps(service.getSettings(), { now: clock })} />), /are paused for about/);
  });
  it("marks environment keys as not removable, and offers removal only for saved keys", () => {
    const base = service.getSettings();
    const env: AiSettingsView = { ...base, providers: base.providers.map((p) => (p.provider === "gemini" ? { ...p, keySource: "environment" as const } : p)) };
    const out = html(<AiProvidersView {...providersProps(env)} />);
    assert.match(out, /Key from environment/);
    assert.match(out, /can&#x27;t be removed here|can&#39;t be removed here/);
    assert.equal((out.match(/Remove saved key/g) ?? []).length, 1);
  });
  it("disables actions while busy and shows notices with the right role", () => {
    const out = html(<AiProvidersView {...providersProps(service.getSettings(), { busy: "save-keys", notice: { tone: "error", text: "Boom" } })} />);
    assert.match(out, /Saving…/);
    assert.match(out, /role="alert"[^>]*>Boom/);
    assert.match(out, /plain text in <code>data\/ai-config\.json<\/code>/);
  });
});

describe("models view", () => {
  it("asks for a key when nothing is configured", () => {
    const empty: AiSettingsView = { ...service.getSettings(), providers: service.getSettings().providers.map((p) => ({ ...p, configured: false })) };
    assert.match(html(<AiModelsView {...modelsProps(empty, [])} />), /No provider is configured/);
  });
  it("lists provider, id, name, context window, coding, free-tier status and availability for real discovered models", async () => {
    const catalogs = await service.listAllModels({ refresh: true });
    const settings = service.getSettings();
    const out = html(<AiModelsView {...modelsProps(settings, catalogs)} />);
    for (const heading of ["Provider", "Model ID", "Name", "Context window", "Coding", "Free tier", "Status"]) assert.match(out, new RegExp(`>${heading}<`));
    for (const c of catalogs) for (const m of c.models.filter((x) => x.availability === "available")) {
      assert.ok(out.includes(`>${m.id}<`), `${m.id} listed`);
      if (m.contextWindow !== null) assert.ok(out.includes(m.contextWindow.toLocaleString("en-US")), `${m.id} context`);
    }
    const shown = catalogs.flatMap((c) => c.models).filter((m) => m.availability === "available");
    assert.equal((out.match(/Not reported/g) ?? []).length, shown.filter((m) => m.contextWindow === null).length, "models without a reported context window say so, others show their number");
    assert.match(out, /Code-focused \(by name\)/);
    assert.match(out, /Not known/);
    assert.equal((out.match(/Not verified/g) ?? []).length >= catalogs.flatMap((c) => c.models).filter((m) => m.availability === "available").length, true);
    assert.doesNotMatch(out, /Free tier \(verified\)/);
    assert.match(out, /not the same as how much quota you have left/);
  });
  it("hides models that can't chat unless asked, and says how many are hidden", async () => {
    const catalogs = await service.listAllModels();
    const settings = service.getSettings();
    const hiddenCount = catalogs.flatMap((c) => c.models).filter((m) => m.availability !== "available").length;
    assert.ok(hiddenCount > 0, "fixtures include non-chat/inactive models");
    const closed = html(<AiModelsView {...modelsProps(settings, catalogs)} />);
    assert.ok(closed.includes(`${hiddenCount} model(s) hidden`));
    assert.doesNotMatch(closed, />whisper-demo</);
    const open = html(<AiModelsView {...modelsProps(settings, catalogs, { showUnusable: true })} />);
    assert.match(open, />whisper-demo</);
    assert.match(open, /Not a chat model/);
    assert.match(open, /Inactive/);
    assert.match(open, /guessed from the name/);
  });
  it("filters by provider", async () => {
    const catalogs = await service.listAllModels();
    const out = html(<AiModelsView {...modelsProps(service.getSettings(), catalogs, { filter: "groq" })} />);
    assert.match(out, />llama-demo-70b</);
    assert.doesNotMatch(out, />gemini-alpha</);
  });
  it("offers only available models of the chosen provider as the default and marks the selected row", async () => {
    const catalogs = await service.listAllModels();
    const settings = service.getSettings();
    const out = html(<AiModelsView {...modelsProps(settings, catalogs, { defaultDraft: { provider: "gemini", model: "gemini-alpha" } })} />);
    const select = /<select id="default-model"[\s\S]*?<\/select>/.exec(out)![0];
    assert.match(select, /gemini-alpha/);
    assert.doesNotMatch(select, /llama-demo-70b|text-embedder/);
    assert.match(out, /aria-selected="true"/);
    assert.match(out, />Selected</);
  });
  it("keeps a draft default that is no longer listed visible and warns when the saved default disappeared", async () => {
    const catalogs = await service.listAllModels();
    const settings: AiSettingsView = { ...service.getSettings(), defaults: { provider: "groq", model: "retired-xyz" }, defaultModelListed: false };
    const out = html(<AiModelsView {...modelsProps(settings, catalogs)} />);
    assert.match(out, /retired-xyz \(not in the current list\)/);
    assert.match(out, /no longer in Groq&#x27;s model list|no longer in Groq&#39;s model list/);
  });
  it("shows a provider's discovery error and marks a stale list", async () => {
    const catalogs = await service.listAllModels();
    const failed: ModelCatalog[] = catalogs.map((c) => (c.provider === "groq" ? { ...c, stale: true, error: { kind: "provider_unavailable", message: "Groq is unavailable.", provider: "groq", status: 503, retryable: true, retryAfterMs: null } } : c));
    const out = html(<AiModelsView {...modelsProps(service.getSettings(), failed)} />);
    assert.match(out, /Groq: Groq is unavailable\. Showing the last list that loaded\./);
  });
  it("disables saving when nothing changed", async () => {
    const catalogs = await service.listAllModels();
    const settings = service.getSettings();
    assert.match(html(<AiModelsView {...modelsProps(settings, catalogs)} />), /disabled=""[^>]*>Save configuration/);
    const changed = html(<AiModelsView {...modelsProps(settings, catalogs, { defaultDraft: { provider: "gemini", model: "gemini-alpha" } })} />);
    assert.doesNotMatch(changed, /disabled=""[^>]*>Save configuration/);
  });
});

describe("formatting helpers", () => {
  it("formats token counts, free tier, durations and hints without inventing values", () => {
    assert.equal(formatTokens(null), "Not reported");
    assert.equal(formatTokens(131072), "131,072 tokens");
    assert.equal(formatFreeTier("unverified"), "Not verified");
    assert.equal(formatDuration(500), "1 s");
    assert.equal(formatDuration(59_100), "1 min", "rounds up to whole seconds, then to minutes");
    assert.equal(formatDuration(59_000), "59 s");
    assert.equal(formatDuration(90_000), "1 min 30 s");
    assert.equal(formatDuration(120_000), "2 min");
    const base = { provider: null, status: null, retryable: false, retryAfterMs: null, message: "m" } as const;
    assert.match(errorHint({ ...base, kind: "rate_limited", retryAfterMs: 5000 }) ?? "", /5 s/);
    assert.equal(errorHint({ ...base, kind: "cancelled" }), null);
  });
  it("test result component handles a model test", () => {
    const result: ConnectionTestResult = { provider: "groq", scope: "model", ok: true, latencyMs: 12, modelCount: null, testedModel: "llama-demo-70b", error: null };
    const out = html(<AiProvidersView {...providersProps(service.getSettings(), { tests: { groq: result } })} />);
    assert.match(out, /Connected\. llama-demo-70b produced a reply\. \(12 ms\)/);
  });
});
