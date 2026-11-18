/**
 * Test support for running code in real Chromium: bundles an entry file with
 * esbuild, serves it from a local HTTP server (IndexedDB needs a real origin)
 * and opens it with Playwright. Lucide icons and Radix Slot are replaced by the
 * same tiny stubs the UI render tests use; Next's <Link> by a plain anchor.
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const npm = createRequire("/opt/npm-tools/node_modules/");
const { build } = npm("esbuild") as typeof import("esbuild");
export const { chromium } = npm("playwright") as typeof import("playwright");

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, "../../..");

/** Every icon the app imports from lucide-react, as an ES module of simple <svg data-icon="Name"> components. */
function writeLucideStub(): string {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry)) for (const m of readFileSync(path, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) for (const n of (m[1] ?? "").split(",")) {
        const name = n.replace(/^\s*type\s+.*/, "").trim().split(/\s+as\s+/)[0]?.trim();
        if (name && /^[A-Z]\w*$/.test(name) && name !== "LucideIcon") names.add(name);
      }
    }
  };
  walk(join(ROOT, "src"));
  const file = join(mkdtempSync(join(tmpdir(), "gtps-lucide-")), "lucide-stub.ts");
  writeFileSync(file, `import { createElement } from "react";\n${[...names].map((n) => `export const ${n} = (props: Record<string, unknown>) => createElement("svg", { "data-icon": "${n}", "aria-hidden": props["aria-hidden"] as never });`).join("\n")}\nexport type LucideIcon = (props: Record<string, unknown>) => unknown;\n`);
  return file;
}

export async function bundle(entry: string): Promise<string> {
  const stubs = process.env.GTPS_UI_STUBS ?? "/tmp/claude-0/-home-claude/09d8e291-d399-505e-8832-e4c8b461274c/scratchpad/ui/stubs";
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    tsconfig: join(ROOT, "tsconfig.json"),
    nodePaths: ["/opt/npm-tools/node_modules"],
    alias: {
      "node:assert/strict": join(HERE, "assert-shim.ts"),
      "lucide-react": writeLucideStub(),
      "@radix-ui/react-slot": join(stubs, "radix-slot.cjs"),
      "next/link": join(HERE, "next-link-stub.tsx"),
      "next/navigation": join(HERE, "next-navigation-stub.ts"),
      "zustand/middleware": join(HERE, "zustand-middleware-stub.ts"),
      zustand: join(HERE, "zustand-stub.ts"),
      "@monaco-editor/react": join(HERE, "monaco-react-stub.tsx"),
    },
    define: { "process.env.NODE_ENV": '"development"' },
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean> | boolean;

export interface TestSite {
  origin: string;
  close(): Promise<void>;
}

/** Serves "/" (an HTML page with the bundle inline) plus any extra routes; the first handler that returns true wins. */
export async function serve(script: string, extra: Handler[] = [], html = '<div id="root"></div>', css = ""): Promise<TestSite> {
  const page = `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body>${html}<script>${script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  const server: Server = createServer(async (req, res) => {
    for (const handler of extra) if (await handler(req, res)) return;
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
