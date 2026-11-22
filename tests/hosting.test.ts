import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createAiClient } from "../src/services/ai-client";
import { register } from "../src/instrumentation";
import { handleHealth } from "../src/server/health";
import { hostedApiResponse, hostedPlatform, isStorageFailure, protectedRoute } from "../src/server/hosting";
import { sessionCookie } from "../src/server/access";
import { authStatus, handleLogin, handleLogout, resetLoginLimiter } from "../src/server/auth-api";
import { openDatabase } from "../src/server/db/database";

const req = (path: string, init: RequestInit & { host?: string } = {}): Request => {
  const { host = "localhost:3000", headers, ...rest } = init;
  return new Request(`http://${host}${path}`, { ...rest, headers: { host, ...(headers as Record<string, string> | undefined) } });
};
const VERCEL = { VERCEL: "1" };
const LOCAL = {};

describe("hosted environments", () => {
  it("recognises hosting services from their own environment variables and ignores empty or false values", () => {
    assert.equal(hostedPlatform({ VERCEL: "1" }), "Vercel");
    assert.equal(hostedPlatform({ NETLIFY: "true" }), "Netlify");
    assert.equal(hostedPlatform({ AWS_LAMBDA_FUNCTION_NAME: "fn" }), "AWS Lambda");
    assert.equal(hostedPlatform({ GTPS_HOSTED: "1" }), "a hosting service");
    assert.equal(hostedPlatform({ VERCEL: "" }), null);
    assert.equal(hostedPlatform({ GTPS_HOSTED: "0" }), null);
    assert.equal(hostedPlatform({ GTPS_HOSTED: "false" }), null);
    assert.equal(hostedPlatform(LOCAL), null);
  });

  const PASSWORD = "correct horse battery";
  const HOST = "gtps-assis.vercel.app";
  const UNLOCKED = { VERCEL: "1", GTPS_ACCESS_PASSWORD: PASSWORD } as Record<string, string>;
  const cookie = (password = PASSWORD) => ({ cookie: sessionCookie(password, true).split(";")[0] as string });

  it("keeps the backend locked (503, with the instruction) while no access password is configured, in the shape each client expects", async () => {
    const plain = hostedApiResponse(req("/api/sync/status", { host: HOST }), VERCEL);
    assert.equal(plain?.status, 503);
    const plainBody = (await plain?.json()) as { error: string; code: string };
    assert.equal(plainBody.code, "backend_unavailable");
    assert.match(plainBody.error, /GTPS_ACCESS_PASSWORD/);

    for (const path of ["/api/ai/settings", "/api/lua/check"]) {
      const res = hostedApiResponse(req(path, { host: HOST }), VERCEL);
      assert.equal(res?.status, 503, path);
      const body = (await res?.json()) as { error: { kind: string; message: string; provider: null; retryable: boolean } };
      assert.equal(body.error.kind, "backend_unavailable");
      assert.match(body.error.message, /GTPS_ACCESS_PASSWORD/);
      assert.equal(body.error.retryable, false);
    }
    assert.equal(hostedApiResponse(req("/api/docs/tree", { host: HOST }), { VERCEL: "1", GTPS_ACCESS_PASSWORD: "short" })?.status, 503, "a password shorter than 8 characters counts as not set");
  });

  it("with a password set, a request without the session cookie gets 401; with it, it passes; health and login are always open", async () => {
    const denied = hostedApiResponse(req("/api/docs/tree", { host: HOST }), UNLOCKED);
    assert.equal(denied?.status, 401);
    assert.equal(((await denied?.json()) as { code: string }).code, "auth_required");
    assert.equal(hostedApiResponse(req("/api/docs/tree", { host: HOST, headers: cookie("another password!") }), UNLOCKED)?.status, 401, "a cookie made from another password is refused");
    assert.equal(hostedApiResponse(req("/api/docs/tree", { host: HOST, headers: { cookie: "gtps_session=garbage" } }), UNLOCKED)?.status, 401);
    assert.equal(hostedApiResponse(req("/api/docs/tree", { host: HOST, headers: cookie() }), UNLOCKED), undefined);
    for (const path of ["/api/health", "/api/auth/status", "/api/auth/login"]) assert.equal(hostedApiResponse(req(path, { host: HOST }), UNLOCKED), undefined, path);
  });

  it("lets pages and everything else through, and does nothing at all when running locally", () => {
    assert.equal(hostedApiResponse(req("/api/health"), VERCEL), undefined);
    assert.equal(hostedApiResponse(req("/settings/providers"), VERCEL), undefined);
    assert.equal(hostedApiResponse(req("/api/ai/settings"), LOCAL), undefined);
  });

  it("login: wrong passwords are refused and counted, the right one sets an HttpOnly, SameSite=Strict, Secure cookie", async () => {
    resetLoginLimiter();
    const login = (password: string, headers: Record<string, string> = {}) =>
      handleLogin(UNLOCKED)(req("/api/auth/login", { host: HOST, method: "POST", body: JSON.stringify({ password }), headers: { "content-type": "application/json", "x-forwarded-proto": "https", ...headers } }));
    assert.equal((await login("nope")).status, 401);
    const ok = await login(PASSWORD);
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /^gtps_session=[0-9a-f]{64}; /);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Secure/);
    assert.doesNotMatch(setCookie, new RegExp(PASSWORD), "the password itself is never in the cookie");
    // The cookie it hands out is accepted by the gate.
    assert.equal(hostedApiResponse(req("/api/docs/tree", { host: HOST, headers: { cookie: setCookie.split(";")[0] as string } }), UNLOCKED), undefined);
  });

  it("login: five wrong passwords lock that client out, even for the right password, and another client is unaffected", async () => {
    resetLoginLimiter();
    const attempt = (password: string, ip: string) =>
      handleLogin(UNLOCKED)(req("/api/auth/login", { host: HOST, method: "POST", body: JSON.stringify({ password }), headers: { "content-type": "application/json", "x-forwarded-for": ip } }));
    for (let i = 0; i < 5; i += 1) assert.equal((await attempt("wrong", "1.1.1.1")).status, 401);
    assert.equal((await attempt(PASSWORD, "1.1.1.1")).status, 429);
    assert.equal((await attempt(PASSWORD, "2.2.2.2")).status, 200);
    resetLoginLimiter();
  });

  it("login does nothing on a local copy, on a host without a password, or with a malformed body; status and logout report honestly", async () => {
    resetLoginLimiter();
    const post = (env: Record<string, string>, body: string) => handleLogin(env)(req("/api/auth/login", { host: HOST, method: "POST", body, headers: { "content-type": "application/json" } }));
    assert.equal((await post({}, "{}")).status, 400);
    assert.equal((await post({ VERCEL: "1" }, "{}")).status, 503);
    assert.equal((await post(UNLOCKED, "not json")).status, 400);
    assert.equal((await post(UNLOCKED, JSON.stringify({ password: 42 }))).status, 401);
    assert.deepEqual(authStatus(req("/api/auth/status"), {}), { hosted: false, configured: true, authenticated: true });
    assert.deepEqual(authStatus(req("/api/auth/status", { host: HOST }), { VERCEL: "1" }), { hosted: true, configured: false, authenticated: false });
    assert.deepEqual(authStatus(req("/api/auth/status", { host: HOST }), UNLOCKED), { hosted: true, configured: true, authenticated: false });
    assert.deepEqual(authStatus(req("/api/auth/status", { host: HOST, headers: cookie() }), UNLOCKED), { hosted: true, configured: true, authenticated: true });
    const out = await handleLogout(UNLOCKED)(req("/api/auth/logout", { host: HOST, method: "POST" }));
    assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  });

  it("the AI client turns that answer into a clear, non-retryable error instead of 'HTTP 503'", async () => {
    const res = hostedApiResponse(req("/api/ai/settings"), VERCEL) as Response;
    const client = createAiClient({ fetch: async () => res.clone() });
    await assert.rejects(client.getSettings(), (error: { info?: { kind: string; message: string; retryable: boolean } }) => {
      assert.equal(error.info?.kind, "backend_unavailable");
      assert.match(error.info?.message ?? "", /GTPS_ACCESS_PASSWORD/);
      assert.equal(error.info?.retryable, false);
      return true;
    });
  });
});

describe("protected routes", () => {
  it("never run the handler for a request addressed to another host, a cross-site request, or a non-JSON mutation", async () => {
    let ran = 0;
    const route = protectedRoute(() => {
      ran += 1;
      return Response.json({ ok: true });
    }, { env: LOCAL });
    assert.equal((await route(req("/api/x"))).status, 200);
    assert.equal(ran, 1);
    assert.equal((await route(req("/api/x", { host: "evil.example" }))).status, 403);
    assert.equal((await route(req("/api/x", { headers: { "sec-fetch-site": "cross-site" } }))).status, 403);
    assert.equal((await route(req("/api/x", { headers: { origin: "http://evil.example" } }))).status, 403);
    assert.equal((await route(req("/api/x", { method: "POST", body: "{}", headers: { "content-type": "text/plain" } }))).status, 403);
    assert.equal((await route(req("/api/x", { method: "DELETE" }))).status, 200, "DELETE carries no body, so it needs no JSON content type");
    assert.equal(ran, 2);
  });

  it("a hosted environment answers 503 before anything else, without running the handler", async () => {
    let ran = false;
    const route = protectedRoute(() => {
      ran = true;
      return Response.json({});
    }, { env: VERCEL });
    const res = await route(req("/api/docs/tree", { host: "gtps-assis.vercel.app" }));
    assert.equal(res.status, 503);
    assert.equal(ran, false);
  });

  it("on a host with a password: no cookie -> 401 and the handler does not run; with the cookie it runs on the deployment's own host name; another origin is still refused", async () => {
    let ran = 0;
    const env = { VERCEL: "1", GTPS_ACCESS_PASSWORD: "correct horse battery" };
    const route = protectedRoute(() => {
      ran += 1;
      return Response.json({ ok: true });
    }, { env });
    const c = { cookie: sessionCookie("correct horse battery", true).split(";")[0] as string };
    assert.equal((await route(req("/api/docs/tree", { host: "gtps-assis.vercel.app" }))).status, 401);
    assert.equal(ran, 0);
    assert.equal((await route(req("/api/docs/tree", { host: "gtps-assis.vercel.app", headers: c }))).status, 200);
    assert.equal((await route(req("/api/x", { host: "gtps-assis.vercel.app", method: "POST", body: "{}", headers: { ...c, "content-type": "application/json", origin: "https://gtps-assis.vercel.app" } }))).status, 200);
    assert.equal((await route(req("/api/x", { host: "gtps-assis.vercel.app", method: "POST", body: "{}", headers: { ...c, "content-type": "application/json", origin: "https://evil.example" } }))).status, 403);
    assert.equal((await route(req("/api/x", { host: "gtps-assis.vercel.app", headers: { ...c, "sec-fetch-site": "cross-site" } }))).status, 403);
    assert.equal(ran, 2);
  });

  it("a storage failure becomes 503 'storage_unavailable' and the path never reaches the client", async () => {
    const logs: string[] = [];
    const route = protectedRoute(() => {
      throw Object.assign(new Error("EROFS: read-only file system, mkdir '/var/task/data'"), { code: "EROFS" });
    }, { env: LOCAL, log: (m) => logs.push(m) });
    const res = await route(req("/api/docs/tree"));
    assert.equal(res.status, 503);
    const text = await res.text();
    assert.match(text, /storage_unavailable/);
    assert.doesNotMatch(text, /\/var\/task/);
    assert.match(logs.join("\n"), /\/var\/task\/data/, "the server log keeps the detail for the person running it");
  });

  it("any other failure becomes a generic 500 JSON error with no message, stack or key", async () => {
    const route = protectedRoute(() => {
      throw new Error(`boom with secret AIza${"0".repeat(35)} at /home/user/app.ts:4`);
    }, { env: LOCAL, log: () => {} });
    const res = await route(req("/api/sync/status"));
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.doesNotMatch(text, /AIza|\/home\/user|boom/);
    assert.equal(((JSON.parse(text) as { code: string }).code), "internal");
  });

  it("uses the AI error shape for /api/ai and the plain shape elsewhere", async () => {
    const route = protectedRoute(() => {
      throw new Error("x");
    }, { env: LOCAL, log: () => {} });
    const ai = (await (await route(req("/api/ai/chat"))).json()) as { error: unknown };
    assert.equal(typeof ai.error, "object");
    const sync = (await (await route(req("/api/sync/start"))).json()) as { error: unknown };
    assert.equal(typeof sync.error, "string");
  });

  it("classifies storage errors without matching ordinary ones", () => {
    assert.equal(isStorageFailure(Object.assign(new Error("x"), { code: "ENOSPC" })), true);
    assert.equal(isStorageFailure(new Error("database is locked")), true);
    assert.equal(isStorageFailure(new Error("node:sqlite is unavailable. Use Node.js 22.13 or newer.")), true);
    assert.equal(isStorageFailure(new Error("Cannot read properties of undefined")), false);
    assert.equal(isStorageFailure("EROFS"), false);
  });
});

describe("health check", () => {
  it("reports local mode with the real number of documents and no paths", async () => {
    const db = openDatabase(":memory:");
    const now = new Date().toISOString();
    for (const n of [1, 2, 3]) {
      db.prepare("INSERT INTO documents (title, url, raw_content, cleaned_content, content_hash, created_at, updated_at, last_scraped_at) VALUES (?,?,?,?,?,?,?,?)").run(`P${n}`, `https://dash.gtps.cloud/docs/p${n}`, "raw", "text", `h${n}`, now, now, now);
    }
    db.prepare("UPDATE documents SET deleted_at = ? WHERE url = 'https://dash.gtps.cloud/docs/p3'").run(now);
    const res = await handleHealth({ env: LOCAL, node: "22.0.0", openDatabase: () => db })(req("/api/health"));
    const body = (await res.json()) as { ok: boolean; mode: string; backend: boolean; database: { documents: number } };
    assert.deepEqual({ ok: body.ok, mode: body.mode, backend: body.backend, documents: body.database.documents }, { ok: true, mode: "local", backend: true, documents: 2 });
  });

  it("answers on a hosting service without opening any database", async () => {
    const res = await handleHealth({ env: VERCEL, openDatabase: () => assert.fail("must not open the database") })(req("/api/health", { host: "gtps-assis.vercel.app" }));
    assert.deepEqual(await res.json(), { ok: true, mode: "hosted", backend: false, platform: "Vercel", node: process.versions.node });
  });

  it("local mode with a database that cannot be opened answers 503, not a crash", async () => {
    const res = await handleHealth({ env: LOCAL, openDatabase: () => { throw Object.assign(new Error("EROFS"), { code: "EROFS" }); } })(req("/api/health"));
    assert.equal(res.status, 503);
  });
});

/** A database path that can never be created: its parent folder would have to live inside a regular file (ENOTDIR on every OS). */
const UNWRITABLE_DB = (() => {
  const file = join(mkdtempSync(join(tmpdir(), "gtps-unwritable-")), "plain-file");
  writeFileSync(file, "not a folder");
  return join(file, "data", "db.sqlite");
})();

describe("server start", () => {
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const saved: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(vars)) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      await fn();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };

  it("does nothing on a hosting service, even when the data folder cannot be written", async () => {
    await withEnv({ NEXT_RUNTIME: "nodejs", VERCEL: "1", GTPS_DB_PATH: UNWRITABLE_DB }, async () => {
      const warn = console.warn;
      const seen: string[] = [];
      console.warn = (m: string) => void seen.push(String(m));
      try {
        await register();
      } finally {
        console.warn = warn;
      }
      assert.match(seen.join(" "), /Vercel: the local backend is disabled/);
    });
  });

  it("does not stop the server from starting when the database cannot be opened", async () => {
    await withEnv({ NEXT_RUNTIME: "nodejs", VERCEL: undefined, GTPS_HOSTED: undefined, GTPS_DB_PATH: UNWRITABLE_DB }, async () => {
      const error = console.error;
      const seen: string[] = [];
      console.error = (m: string) => void seen.push(String(m));
      try {
        await register(); // must resolve
      } finally {
        console.error = error;
      }
      assert.match(seen.join(" "), /background services could not start/);
    });
  });
});
