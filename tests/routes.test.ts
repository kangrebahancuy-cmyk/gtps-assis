/**
 * The real src/app/api/**\/route.ts files, called as Next.js calls them (Request in, Response out) against a real
 * SQLite file in a temp folder. This is the wiring no handler-level test covers: the route's own imports, the
 * runtime singletons, protectedRoute, and the JSON each endpoint actually returns.
 *
 * Not covered here: Next.js itself (routing, bundling, the Edge middleware runtime).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";

import { body, FakeFetcher, testConfig } from "./helpers";
import { fakeExtract } from "./helpers";

const ORIGIN = "https://dash.gtps.cloud";
const dir = mkdtempSync(join(tmpdir(), "gtps-routes-"));
process.env.GTPS_DB_PATH = join(dir, "data.sqlite");
process.env.GTPS_AI_CONFIG_PATH = join(dir, "ai.json");
for (const name of ["VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE", "GTPS_HOSTED"]) delete process.env[name];

type RouteModule = Record<string, unknown>;
const ROUTES_DIR = join(process.cwd(), "src/app/api");
const routeFiles = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? routeFiles(p) : f === "route.ts" ? [p] : [];
  });
const files = routeFiles(ROUTES_DIR);
const pathOf = (file: string) => `/api/${relative(ROUTES_DIR, file).replace(/\/?route\.ts$/, "")}`;

const call = async (file: string, method: string, path: string, init: { host?: string; json?: unknown; headers?: Record<string, string> } = {}): Promise<Response> => {
  const mod = (await import(file)) as RouteModule;
  const handler = mod[method] as ((request: Request) => Promise<Response>) | undefined;
  assert.equal(typeof handler, "function", `${file} exports ${method}`);
  const host = init.host ?? "localhost:3000";
  const url = `http://${host}${path}`;
  const request = new Request(url, {
    method,
    headers: { host, ...(init.json !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  return handler(Object.assign(request, { nextUrl: new URL(url) }));
};
const route = (name: string) => join(ROUTES_DIR, name, "route.ts");

before(async () => {
  // Seed the SAME database the routes read, through the real sync service with an in-memory fake site.
  const { getSyncRuntime } = await import("../src/server/sync/runtime");
  const { SyncService } = await import("../src/server/sync/sync-service");
  const { repo } = getSyncRuntime();
  const site = new FakeFetcher({
    [`${ORIGIN}/docs`]: { html: body({ title: "Overview", text: "Welcome to the GTPS Lua reference. Use the player API to teleport players.", links: ["/docs/player", "/docs/events/chat"] }) },
    [`${ORIGIN}/docs/player`]: { html: body({ title: "Player", text: "Player:getName() returns the avatar name. Player:enterWorld(worldName) moves the avatar to a world.", code: ['local name = player:getName()'] }) },
    [`${ORIGIN}/docs/events/chat`]: { html: body({ title: "Chat events", text: "onPlayerChatCallback fires for every chat message sent in a world." }) },
  });
  const service = new SyncService({ repo, config: testConfig({ startUrl: `${ORIGIN}/docs` }), createFetcher: () => site, loadRobots: async () => null, extract: fakeExtract, sleep: async () => {} });
  const run = service.start("full");
  assert.ok(run.ok, "seed sync started");
  await service.whenIdle();
});
after(async () => {
  const { getSyncRuntime } = await import("../src/server/sync/runtime");
  getSyncRuntime().scheduler.stop(); // the status route starts the scheduler; its timer would keep the process alive
  rmSync(dir, { recursive: true, force: true });
});

describe("route files", () => {
  it("there is a healthy number of routes and each one is wrapped by protectedRoute (except /api/health, which has its own guard)", () => {
    assert.ok(files.length >= 20, `found ${files.length} route files`);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      if (file.endsWith("health/route.ts")) continue;
      const exported = [...text.matchAll(/^export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE)\b/gm)].map((m) => m[1]);
      assert.ok(exported.length > 0, `${file} exports a handler`);
      for (const method of exported) assert.match(text, new RegExp(`export const ${method} = protectedRoute\\(`), `${relative(process.cwd(), file)}: ${method} must use protectedRoute`);
    }
  });
});

describe("every endpoint refuses what is not this computer", () => {
  it("a wrong Host header gets 403 from every route and method, and nothing is run", async () => {
    let checked = 0;
    for (const file of files) {
      if (file.endsWith("health/route.ts")) continue;
      const mod = (await import(file)) as RouteModule;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        const res = await call(file, method, `${pathOf(file)}`, { host: "attacker.example", json: method === "GET" || method === "DELETE" ? undefined : {} });
        assert.equal(res.status, 403, `${method} ${pathOf(file)}`);
        const text = await res.text();
        assert.doesNotMatch(text, /AIza|gsk_|\.sqlite|\/tmp\//);
        checked += 1;
      }
    }
    assert.ok(checked >= 20, `checked ${checked} handlers`);
  });

  it("a cross-site browser request and a non-JSON mutation are refused", async () => {
    assert.equal((await call(route("docs/status"), "GET", "/api/docs/status", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await call(route("lua/check"), "POST", "/api/lua/check", { headers: { "content-type": "text/plain" } })).status, 403);
    assert.equal((await call(route("sync/settings"), "PUT", "/api/sync/settings", { headers: { origin: "https://evil.example" }, json: { autoSync: true } })).status, 403);
  });
});

describe("the read endpoints answer from the real database", () => {
  it("health reports local mode and the number of documents that were really indexed", async () => {
    const res = await call(route("health"), "GET", "/api/health");
    assert.equal(res.status, 200);
    const h = (await res.json()) as { mode: string; backend: boolean; database: { documents: number } };
    assert.deepEqual({ mode: h.mode, backend: h.backend, documents: h.database.documents }, { mode: "local", backend: true, documents: 3 });
  });

  it("docs status, tree, search, context, examples and a document", async () => {
    const status = (await (await call(route("docs/status"), "GET", "/api/docs/status")).json()) as { totals: { documents: number; searchIndexed: number } };
    assert.deepEqual([status.totals.documents, status.totals.searchIndexed], [3, 3], "all three pages are indexed and searchable");
    const tree = await call(route("docs/tree"), "GET", "/api/docs/tree");
    assert.equal(tree.status, 200);
    assert.match(JSON.stringify(await tree.json()), /Player/);
    const search = (await (await call(route("docs/search"), "GET", "/api/docs/search?q=teleport&scope=all")).json()) as { results?: unknown[] } | unknown[];
    const list = Array.isArray(search) ? search : (search.results ?? []);
    assert.ok(list.length >= 1, "searching 'teleport' finds the overview page");
    const empty = await call(route("docs/search"), "GET", "/api/docs/search?q=zzzznothingmatches");
    assert.equal(empty.status, 200, "an empty search is a normal, empty answer");
    const ex = await call(route("docs/examples"), "GET", "/api/docs/examples");
    assert.equal(ex.status, 200);
    assert.match(JSON.stringify(await ex.json()), /getName/);
    const missing = await call(route("docs/document"), "GET", "/api/docs/document?id=999999");
    assert.equal(missing.status, 404);
  });

  it("sync status/settings/logs/runs and docs-source answer with JSON", async () => {
    for (const name of ["sync/status", "sync/settings", "sync/logs", "sync/runs", "docs-source"]) {
      const res = await call(route(name), "GET", `/api/${name}`);
      assert.equal(res.status, 200, name);
      assert.match(res.headers.get("content-type") ?? "", /json/, name);
    }
    const src = (await (await call(route("docs-source"), "GET", "/api/docs-source")).json()) as { settings: { sourceUrl: string }; documents: number };
    assert.equal(src.settings.sourceUrl, "https://dash.gtps.cloud/docs");
    assert.equal(src.documents, 3);
  });

  it("AI settings say nothing is configured and never contain a key", async () => {
    const res = await call(route("ai/settings"), "GET", "/api/ai/settings");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"configured":false/);
    assert.doesNotMatch(text, /apiKey"\s*:\s*"[^"]+"/);
  });
});

describe("the write endpoints validate their input", () => {
  it("the Lua check reports a syntax error in malformed code and never runs it", async () => {
    const globalFlag = "__lua_ran__";
    const res = await call(route("lua/check"), "POST", "/api/lua/check", { json: { code: `os.execute("touch /tmp/${globalFlag}")\nif then end end (` } });
    assert.equal(res.status, 200);
    const report = JSON.stringify(await res.json());
    assert.match(report, /syntax/i);
    assert.equal(statSyncSafe(`/tmp/${globalFlag}`), false, "the script was only analysed, never executed");
  });

  it("rejects non-text code, oversized bodies and invalid JSON with 400-level JSON errors", async () => {
    const bad = await call(route("lua/check"), "POST", "/api/lua/check", { json: { code: 42 } });
    assert.equal(bad.status, 400);
    const huge = await call(route("lua/check"), "POST", "/api/lua/check", { json: { code: "x".repeat(250_000) } });
    assert.equal(huge.status, 400);
    const mod = (await import(route("lua/check"))) as RouteModule;
    const broken = await (mod.POST as (r: Request) => Promise<Response>)(new Request("http://localhost:3000/api/lua/check", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json" }, body: "{not json" }));
    assert.equal(broken.status, 400);
  });

  it("changing the documentation source to an unapproved site is refused (domain restriction)", async () => {
    const res = await call(route("docs-source"), "PUT", "/api/docs-source", { json: { sourceUrl: "https://evil.example/docs" } });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(await res.json()), /not an approved|approved/i);
    const lookalike = await call(route("docs-source"), "PUT", "/api/docs-source", { json: { sourceUrl: "https://evilgtps.cloud/docs" } });
    assert.equal(lookalike.status, 400);
  });

  it("saving an AI key stores it, and no endpoint ever returns it again", async () => {
    const key = `AIza${"0".repeat(35)}`;
    const saved = await call(route("ai/config"), "PUT", "/api/ai/config", { json: { keys: { gemini: key } } });
    assert.ok(saved.status < 300, `status ${saved.status}`);
    assert.doesNotMatch(await saved.text(), new RegExp(key));
    for (const name of ["ai/settings", "ai/models", "health", "docs-source", "sync/status"]) {
      const res = await call(route(name), "GET", `/api/${name}`);
      assert.doesNotMatch(await res.text(), new RegExp(key), name);
    }
    const stored = readFileSync(join(dir, "ai.json"), "utf8");
    assert.match(stored, new RegExp(key), "it is stored locally (that is the point) ...");
    assert.equal((statSync(join(dir, "ai.json")).mode & 0o777).toString(8), "600", "... readable only by the owner");
  });
});

function statSyncSafe(p: string): boolean {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
