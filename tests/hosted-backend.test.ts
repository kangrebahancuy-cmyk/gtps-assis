/**
 * The backend on a serverless host: where it keeps files, how the crawl is tuned, and that keys can only come from
 * the host's environment variables.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { handleSaveConfig } from "@/server/ai/api";
import { AiConfigStore } from "@/server/ai/config-store";
import { AiService } from "@/server/ai/service";
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

describe("provider keys on a host", () => {
  it("cannot be saved from the settings page (the disk is temporary)", async () => {
    process.env.VERCEL = "1";
    const dir = mkdtempSync(join(tmpdir(), "gtps-hosted-"));
    const service = new AiService({ store: new AiConfigStore(join(dir, "c.json"), {}), providers: {} as never });
    const put = (body: unknown) => handleSaveConfig(service)(new Request("https://gtps-assis.vercel.app/api/ai/config", { method: "PUT", headers: { host: "gtps-assis.vercel.app", "content-type": "application/json" }, body: JSON.stringify(body) }));
    const refused = await put({ keys: { gemini: `AIza${"0".repeat(35)}` } });
    assert.equal(refused.status, 400);
    assert.match(JSON.stringify(await refused.json()), /GEMINI_API_KEY/);
  });
});
