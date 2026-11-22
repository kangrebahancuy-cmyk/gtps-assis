/**
 * The backend on a serverless host: where it keeps files, how the crawl is tuned, and that keys can only come from
 * the host's environment variables.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { handleGetSettings, handleSaveConfig } from "@/server/ai/api";
import { CookieConfigStore } from "@/server/ai/cookie-store";
import { withAiService } from "@/server/ai/runtime";
import { getAiConfigPath, getDatabasePath } from "@/server/scraper/config";
import { hostedScraperOverrides } from "@/server/sync/runtime";

const saved = { VERCEL: process.env.VERCEL, GTPS_DB_PATH: process.env.GTPS_DB_PATH, GTPS_AI_CONFIG_PATH: process.env.GTPS_AI_CONFIG_PATH };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("files on a serverless host", () => {
  it("default to /tmp (the only writable place) on a host, and to ./data locally; explicit paths always win", () => {
    delete process.env.GTPS_DB_PATH;
    delete process.env.GTPS_AI_CONFIG_PATH;
    delete process.env.VERCEL;
    assert.equal(getDatabasePath(), "data/gtps-assistant.db");
    assert.equal(getAiConfigPath(), "data/ai-config.json");
    process.env.VERCEL = "1";
    assert.equal(getDatabasePath(), "/tmp/gtps-assistant.db");
    assert.equal(getAiConfigPath(), "/tmp/gtps-ai-config.json");
    process.env.GTPS_DB_PATH = "/somewhere/else.db";
    assert.equal(getDatabasePath(), "/somewhere/else.db");
  });
});

describe("crawl settings on a host", () => {
  it("are quicker, HTTP only, stop before the function time limit and resume; locally nothing changes", () => {
    assert.deepEqual(hostedScraperOverrides({}), {});
    const hosted = hostedScraperOverrides({ VERCEL: "1" });
    assert.equal(hosted.renderMode, "static");
    assert.equal(hosted.resumeUnfinished, true);
    assert.ok(hosted.requestDelayMs !== undefined && hosted.requestDelayMs >= 200, "still polite");
    assert.ok(hosted.deadlineMs !== undefined && hosted.deadlineMs < 60_000, "ends before the 60 s function limit");
  });
});

describe("provider keys on a host: an encrypted HttpOnly cookie of the visitor's browser", () => {
  const PASSWORD = "correct horse battery";
  const ENV = { VERCEL: "1", GTPS_ACCESS_PASSWORD: PASSWORD };
  const KEY = `AIza${"1".repeat(35)}`;
  beforeEach(() => {
    process.env.VERCEL = "1"; // the handlers read the real environment for the host check
  });
  const req = (cookie?: string) => new Request("https://gtps-assis.vercel.app/api/ai/settings", { headers: { host: "gtps-assis.vercel.app", ...(cookie ? { cookie } : {}) } });

  it("a key added in the page is stored sealed in a cookie: not readable, not containing the key, HttpOnly, and accepted only under the same password", async () => {
    const store = new CookieConfigStore(req(), PASSWORD, {});
    assert.equal(store.setCookieHeader(true), null, "nothing changed, nothing to set");
    store.setKey("gemini", KEY);
    store.setDefaults({ provider: "gemini", model: "gemini-x" });
    const header = store.setCookieHeader(true) as string;
    assert.match(header, /^gtps_ai=[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Strict; Secure; Max-Age=\d+$/);
    assert.equal(header.includes(KEY), false);
    assert.equal(header.includes(Buffer.from(KEY).toString("base64")), false);
    const cookie = header.split(";")[0] as string;

    const same = new CookieConfigStore(req(cookie), PASSWORD, {});
    assert.deepEqual(same.resolveKey("gemini"), { key: KEY, source: "saved" });
    assert.deepEqual(same.getDefaults(), { provider: "gemini", model: "gemini-x" });
    assert.equal(same.resolveKey("groq"), null);

    const other = new CookieConfigStore(req(cookie), "a different password", {});
    assert.equal(other.resolveKey("gemini"), null, "another password cannot open it");
    const tampered = cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA");
    assert.equal(new CookieConfigStore(req(tampered), PASSWORD, {}).resolveKey("gemini"), null, "a modified cookie is ignored");
    assert.equal(new CookieConfigStore(req("gtps_ai=garbage"), PASSWORD, {}).resolveKey("gemini"), null);
  });

  it("removing the last key clears the cookie; an environment key is still the fallback", () => {
    const store = new CookieConfigStore(req(), PASSWORD, { GROQ_API_KEY: `gsk_${"a".repeat(30)}` });
    assert.equal(store.resolveKey("groq")?.source, "environment");
    store.setKey("gemini", KEY);
    store.removeKey("gemini");
    assert.match(store.setCookieHeader(true) as string, /^gtps_ai=; .*Max-Age=0$/);
  });

  it("through the real handlers: save -> Set-Cookie on the response -> the next request sees the key as configured, and the response never contains it", async () => {
    const save = new Request("https://gtps-assis.vercel.app/api/ai/config", { method: "PUT", headers: { host: "gtps-assis.vercel.app", "content-type": "application/json" }, body: JSON.stringify({ keys: { gemini: KEY } }) });
    const saved = await withAiService(save, (service) => handleSaveConfig(service), ENV);
    assert.equal(saved.status, 200);
    const setCookie = saved.headers.get("set-cookie") as string;
    assert.match(setCookie, /HttpOnly/);
    assert.equal((await saved.clone().text()).includes(KEY), false);

    const next = await withAiService(req(setCookie.split(";")[0]), (service) => handleGetSettings(service), ENV);
    const view = (await next.json()) as { providers: Array<{ provider: string; configured: boolean; keySource: string | null; keyHint: string | null }> };
    const gemini = view.providers.find((p) => p.provider === "gemini");
    assert.equal(gemini?.configured, true);
    assert.equal(gemini?.keySource, "saved");
    assert.equal(gemini?.keyHint, "…1111");
    assert.equal(next.headers.get("set-cookie"), null, "reading changes nothing");

    const without = await withAiService(req(), (service) => handleGetSettings(service), ENV);
    assert.equal(((await without.json()) as typeof view).providers.find((p) => p.provider === "gemini")?.configured, false);
  });
});
