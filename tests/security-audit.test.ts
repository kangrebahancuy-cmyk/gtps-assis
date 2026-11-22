/**
 * Source-level guards for the Step 11 security audit. They cannot prove the absence of every bug; they stop the
 * specific mistakes that would be serious here from coming back unnoticed.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const ROOT = process.cwd();
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
const sources = walk(join(ROOT, "src")).map((file) => ({ path: relative(ROOT, file), text: readFileSync(file, "utf8") }));

describe("no code execution", () => {
  it("the app never evaluates text as code (eval, new Function, vm, child processes, workers)", () => {
    const banned = /\beval\s*\(|new\s+Function\s*\(|from\s+["'](?:node:)?(?:vm|child_process|worker_threads)["']|require\(["'](?:node:)?(?:vm|child_process)["']\)|\bsetTimeout\(\s*["'`]/;
    for (const { path, text } of sources) assert.doesNotMatch(text.replace(/\/\/.*$/gm, ""), banned, path);
  });

  it("no Lua interpreter is a dependency: generated scripts can only be analysed, never run", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    assert.deepEqual(names.filter((n) => /lua|fengari|wasmoon|moonshine/i.test(n)), []);
  });
});

describe("no unsafe HTML", () => {
  it("dangerouslySetInnerHTML is used once: the theme script, whose content is a constant of this app", () => {
    const uses = sources.filter(({ text }) => text.includes("dangerouslySetInnerHTML"));
    assert.deepEqual(uses.map((u) => u.path), ["src/app/layout.tsx"]);
    const layout = uses[0]?.text ?? "";
    assert.match(layout, /__html: THEME_INIT_SCRIPT/);
    const script = /const THEME_INIT_SCRIPT = `([\s\S]*?)`;/.exec(layout)?.[1] ?? "";
    assert.ok(script.length > 0, "the injected string is a template literal");
    // The only insertions allowed are JSON.stringify(<storage key constant>): fixed strings of this app.
    const insertions = [...script.matchAll(/\$\{([\s\S]*?)\}/g)].map((m) => (m[1] ?? "").replace(/\s+/g, ""));
    assert.ok(insertions.length > 0);
    for (const i of insertions) assert.match(i, /^JSON\.stringify\(STORAGE_KEYS\.\w+,?\)$/, i);
  });

  it("nothing assigns innerHTML/outerHTML or writes into the document", () => {
    for (const { path, text } of sources) assert.doesNotMatch(text, /\.(?:inner|outer)HTML\s*=|document\.write\(|insertAdjacentHTML\(/, path);
  });
});

describe("secrets stay on the server", () => {
  it("client code never reads the AI config file or its path (the settings page only describes where it is)", () => {
    for (const { path, text } of sources) {
      if (path.startsWith("src/server/") || path.startsWith("src/app/api/")) continue;
      assert.doesNotMatch(text, /GTPS_AI_CONFIG_PATH|getAiConfigPath|readFileSync|AiConfigStore/, path);
    }
  });

  it("only server code touches the filesystem or the database", () => {
    for (const { path, text } of sources) {
      if (path.startsWith("src/server/") || path === "src/instrumentation.ts" || path.startsWith("src/app/api/")) continue;
      assert.doesNotMatch(text, /from\s+["']node:(?:fs|sqlite|child_process)["']/, path);
    }
  });

  it("outbound requests from the server go only through code that applies the host rules", () => {
    const fetchers = sources.filter(({ path, text }) => path.startsWith("src/server/") && /\bfetch\(/.test(text.replace(/\/\/.*$/gm, ""))).map((s) => s.path).sort();
    // scraper: redirects followed by hand (crawler robots.txt) or through fetchStatic (guarded); ai: fixed provider URLs, key in a header. A new file that calls fetch must be reviewed and added here.
    assert.deepEqual(fetchers, ["src/server/ai/http.ts", "src/server/ai/service.ts", "src/server/scraper/browser-fetcher.ts", "src/server/scraper/crawler.ts"]);
  });

  it("no fetch in the server follows redirects automatically", () => {
    for (const { path, text } of sources) {
      if (!path.startsWith("src/server/scraper/")) continue;
      assert.doesNotMatch(text, /redirect:\s*["']follow["']/, path);
    }
  });
});
