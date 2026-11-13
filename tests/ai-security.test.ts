/**
 * Security properties of the AI integration that can be checked statically:
 * no committed secrets, keys never reachable from client bundles, safe file
 * storage, and a clean .env.example.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { AiConfigStore } from "@/server/ai/config-store";

const ROOT = process.cwd();
const git = (...args: string[]) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

/** Files git would commit: tracked plus untracked-but-not-ignored. */
const committable = (): string[] => [...new Set([...git("ls-files"), ...git("ls-files", "--others", "--exclude-standard")])].filter((f) => existsSync(join(ROOT, f)));

describe("secrets in the repository", () => {
  it("no committable file contains a key-shaped string; test fixtures must be visibly fake (a run of zeros)", () => {
    const pattern = /(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z_-]{20,})/g;
    const hits: string[] = [];
    for (const file of committable()) {
      if (/\.(png|jpe?g|ico|woff2?|lock)$/i.test(file) || file === "package-lock.json") continue;
      const text = readFileSync(join(ROOT, file), "utf8");
      for (const match of text.match(pattern) ?? []) {
        const placeholder = file.startsWith("tests/") && /0{7}/.test(match);
        if (!placeholder) hits.push(`${file}: ${match.slice(0, 10)}…`);
      }
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) hits.push(`${file}: private key block`);
    }
    assert.deepEqual(hits, []);
  });
  it(".env.example documents the variables without any value", () => {
    const lines = readFileSync(join(ROOT, ".env.example"), "utf8").split("\n").filter((l) => /^[A-Z_]+=/.test(l));
    assert.ok(lines.some((l) => l.startsWith("GEMINI_API_KEY=")));
    assert.ok(lines.some((l) => l.startsWith("GROQ_API_KEY=")));
    for (const l of lines) assert.match(l, /^[A-Z_]+=$/, `${l} should be empty`);
  });
  it("git ignores real env files, the data directory and saved config, but not .env.example", () => {
    const ignored = (path: string) => {
      try {
        execFileSync("git", ["check-ignore", "-q", path], { cwd: ROOT });
        return true;
      } catch {
        return false;
      }
    };
    for (const p of [".env", ".env.local", ".env.production", "data/ai-config.json", "data/gtps-assistant.db"]) assert.equal(ignored(p), true, `${p} should be ignored`);
    assert.equal(ignored(".env.example"), false);
    const files = committable();
    assert.ok(files.includes(".env.example"), ".env.example should be committed");
    assert.deepEqual(files.filter((f) => f.startsWith("data/") || (/^\.env/.test(f) && f !== ".env.example")), []);
  });
});

describe("keys never reach the browser", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const sources = walk(join(ROOT, "src")).filter((f) => /\.(ts|tsx)$/.test(f));
  const rel = (f: string) => relative(ROOT, f).split("\\").join("/");

  it("client-side code never imports server modules", () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const path = rel(file);
      // instrumentation.ts is a server-only entry point (Next never bundles it for the browser).
      const isServerSide = path.startsWith("src/server/") || /^src\/app\/api\//.test(path) || path === "src/instrumentation.ts";
      if (isServerSide) continue;
      const text = readFileSync(file, "utf8");
      if (/from\s+["']@\/server\//.test(text) || /from\s+["'](?:\.\.?\/)+server\//.test(text) || /import\(\s*["']@\/server\//.test(text)) offenders.push(path);
    }
    assert.deepEqual(offenders, []);
  });
  it("server modules that touch keys are not marked 'use client' and read no NEXT_PUBLIC_ variables", () => {
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      assert.doesNotMatch(text, /NEXT_PUBLIC_[A-Z_]*(GEMINI|GROQ|API_KEY)/, `${rel(file)} exposes a key through NEXT_PUBLIC_`);
      if (rel(file).startsWith("src/server/")) assert.doesNotMatch(text, /^["']use client["']/m, rel(file));
    }
  });
  it("the browser-facing types and client never carry an apiKey field in a response shape", () => {
    const types = readFileSync(join(ROOT, "src/types/ai.ts"), "utf8");
    assert.doesNotMatch(types, /\bapiKey\b|\bapi_key\b/i);
  });
  it("every AI route runs on the Node runtime, is never statically cached, and only delegates to a handler", () => {
    const routes = walk(join(ROOT, "src/app/api/ai")).filter((f) => f.endsWith("route.ts"));
    assert.deepEqual(routes.map((r) => rel(r).split("/").slice(-2)[0]).sort(), ["chat", "config", "models", "settings", "test"]);
    for (const file of routes) {
      const text = readFileSync(file, "utf8");
      assert.match(text, /runtime\s*=\s*"nodejs"/, rel(file));
      assert.match(text, /dynamic\s*=\s*"force-dynamic"/, rel(file));
      assert.match(text, /getAiService\(\)/, rel(file));
      assert.doesNotMatch(text, /process\.env/, `${rel(file)} should not read the environment itself`);
    }
  });
  it("provider keys are only sent in headers, never in a URL", () => {
    for (const f of ["src/server/ai/providers/gemini.ts", "src/server/ai/providers/groq.ts"]) {
      const text = readFileSync(join(ROOT, f), "utf8");
      assert.doesNotMatch(text, /[?&]key=/, `${f} puts the key in the URL`);
    }
  });
});

describe("local config file", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "gtps-store-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const path = () => join(dir, "nested", "ai-config.json");
  const KEY = "gsk_unit_test_key_0000000000000000";

  it("creates the directory and file with owner-only permissions and leaves no temp file", () => {
    const store = new AiConfigStore(path(), {});
    store.setKey("groq", KEY);
    if (process.platform !== "win32") {
      assert.equal(statSync(path()).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "nested")).mode & 0o777, 0o700);
    }
    assert.deepEqual(readdirSync(join(dir, "nested")), ["ai-config.json"]);
  });
  it("keeps owner-only permissions when rewriting a file that was made world-readable", () => {
    const store = new AiConfigStore(path(), {});
    store.setKey("groq", KEY);
    if (process.platform === "win32") return;
    chmodSync(path(), 0o644);
    store.setKey("groq", `${KEY}x`);
    assert.equal(statSync(path()).mode & 0o777, 0o600);
  });
  it("round-trips keys and defaults, removes a key, and clears defaults that pointed at it", () => {
    const store = new AiConfigStore(path(), {});
    store.setKey("groq", KEY);
    store.setDefaults({ provider: "groq", model: "m1" });
    assert.deepEqual(store.resolveKey("groq"), { key: KEY, source: "saved" });
    assert.equal(store.resolveKey("gemini"), null);
    assert.deepEqual(store.getDefaults(), { provider: "groq", model: "m1" });
    store.removeKey("groq");
    assert.equal(store.resolveKey("groq"), null);
    assert.deepEqual(store.getDefaults(), { provider: null, model: null });
  });
  it("removing one provider keeps the other's key and defaults", () => {
    const store = new AiConfigStore(path(), {});
    store.setKey("groq", KEY);
    store.setKey("gemini", "AIzaSy_unit_test_key_000000000000");
    store.setDefaults({ provider: "groq", model: "m1" });
    store.removeKey("gemini");
    assert.equal(store.resolveKey("groq")?.key, KEY);
    assert.deepEqual(store.getDefaults(), { provider: "groq", model: "m1" });
  });
  it("ignores unusable stored keys and defaults of the wrong shape, without failing", () => {
    writeFileSync(join(dir, "c.json"), JSON.stringify({ keys: { groq: "bad key", gemini: 5 }, defaults: { provider: "openai", model: "x" } }));
    const store = new AiConfigStore(join(dir, "c.json"), {});
    assert.equal(store.resolveKey("groq"), null);
    assert.equal(store.resolveKey("gemini"), null);
    assert.deepEqual(store.getDefaults(), { provider: null, model: null });
  });
  it("backs up a corrupt file and starts clean; the next save does not lose the backup", () => {
    writeFileSync(join(dir, "c.json"), "{ truncated");
    const store = new AiConfigStore(join(dir, "c.json"), {});
    assert.equal(store.resolveKey("groq"), null);
    store.setKey("groq", KEY);
    assert.equal(readFileSync(join(dir, "c.json.corrupt"), "utf8"), "{ truncated");
    assert.equal(store.resolveKey("groq")?.key, KEY);
  });
  it("a saved key wins over the environment; an unusable environment key is ignored", () => {
    const env = { GROQ_API_KEY: "gsk_from_environment_000000000000" };
    const store = new AiConfigStore(path(), env);
    assert.deepEqual(store.resolveKey("groq"), { key: env.GROQ_API_KEY, source: "environment" });
    store.setKey("groq", KEY);
    assert.deepEqual(store.resolveKey("groq"), { key: KEY, source: "saved" });
    assert.equal(new AiConfigStore(path(), { GROQ_API_KEY: "has spaces" }).resolveKey("gemini"), null);
  });
  it("refuses to store an invalid key", () => {
    const store = new AiConfigStore(path(), {});
    assert.throws(() => store.setKey("groq", "short"));
    assert.equal(existsSync(path()), false);
  });
});
