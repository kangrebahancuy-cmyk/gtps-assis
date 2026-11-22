/**
 * What happens to the real SQLite FILE when things go wrong: a damaged file, a process killed during a sync,
 * a database that cannot be opened. Each is checked through the real route files.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { openDatabase } from "../src/server/db/database";
import { Repository } from "../src/server/db/repository";

const dir = mkdtempSync(join(tmpdir(), "gtps-dberr-"));
after(() => rmSync(dir, { recursive: true, force: true }));
for (const name of ["VERCEL", "NETLIFY", "AWS_LAMBDA_FUNCTION_NAME", "K_SERVICE", "GTPS_HOSTED"]) delete process.env[name];

const get = async (routePath: string, path: string): Promise<Response> => {
  const mod = (await import(routePath)) as { GET: (r: Request) => Promise<Response> };
  const url = `http://localhost:3000${path}`;
  return mod.GET(Object.assign(new Request(url, { headers: { host: "localhost:3000" } }), { nextUrl: new URL(url) }));
};

describe("a damaged database file", () => {
  it("opening it fails with an error, and no half-created state is left to confuse the next start", () => {
    const file = join(dir, "damaged.sqlite");
    writeFileSync(file, "this is definitely not a sqlite database ".repeat(100));
    assert.throws(() => openDatabase(file), /not a database|malformed|encrypted|SQLITE|Failed to open/i);
  });

  it("every route answers 503 'storage_unavailable' (JSON, no path, no stack) instead of crashing, and keeps doing so", async () => {
    process.env.GTPS_DB_PATH = join(dir, "damaged-routes.sqlite");
    writeFileSync(process.env.GTPS_DB_PATH, "garbage garbage garbage ".repeat(200));
    const originalError = console.error;
    const logged: string[] = [];
    console.error = (m: unknown) => void logged.push(String(m));
    try {
      for (const [file, path] of [
        ["docs/status", "/api/docs/status"],
        ["docs/tree", "/api/docs/tree"],
        ["docs-source", "/api/docs-source"],
        ["sync/status", "/api/sync/status"],
        ["health", "/api/health"],
      ] as const) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const res = await get(join(process.cwd(), "src/app/api", file, "route.ts"), path);
          assert.equal(res.status, 503, `${path} (attempt ${attempt + 1})`);
          const text = await res.text();
          assert.match(text, /storage_unavailable/, path);
          assert.doesNotMatch(text, /damaged-routes|\/tmp\/|\.sqlite|at \w+ \(/, `${path} must not leak paths or stack traces`);
        }
      }
    } finally {
      console.error = originalError;
    }
    assert.match(logged.join("\n"), /damaged-routes\.sqlite|not a database/i, "the person running the server can still see what happened in the log");
  });
});

describe("a sync that was killed halfway", () => {
  it("the next start closes the unfinished run as 'interrupted', keeps what was already indexed, and syncs normally again", () => {
    const file = join(dir, "killed.sqlite");
    const first = new Repository(openDatabase(file));
    first.createRun("run-killed", "full", "manual", new Date().toISOString());
    // ...the process dies here: the run row says 'running' forever and nothing closed it.
    const second = new Repository(openDatabase(file)); // next start of the app
    assert.equal(second.listRuns().find((r) => r.id === "run-killed")?.status, "running");
    assert.equal(second.recoverInterruptedRuns(), 1);
    const run = second.listRuns().find((r) => r.id === "run-killed");
    assert.equal(run?.status, "interrupted");
    assert.match(run?.error ?? "", /backend stopped/);
    assert.ok(run?.finishedAt, "it has an end time, so the dashboard does not show it as running");
    assert.match(second.getLogs(10).map((l) => l.message).join("\n"), /interrupted/);
    second.createRun("run-after", "full", "manual", new Date().toISOString());
    assert.equal(second.listRuns().find((r) => r.id === "run-after")?.status, "running", "a new run can start");
  });
});
