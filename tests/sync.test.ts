import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { FetchError } from "@/server/scraper/fetcher";
import { SyncService } from "@/server/sync/sync-service";
import type { SyncRequestMode } from "@/types/sync";
import { BASE, FakeFetcher, body, fakeExtract, testConfig, type Route } from "./helpers";

const u = (path: string) => `${BASE}${path}`;
const HOME = u("/docs");
const A = u("/docs/a");
const B = u("/docs/b");
const C = u("/docs/c");

const page = (title: string, text: string, links: string[] = [], etag?: string): Route => ({
  html: body({ title, text, links }),
  ...(etag ? { etag } : {}),
});

/** A three-page site where every page except home has an ETag. */
const baseSite = (): Record<string, Route> => ({
  [HOME]: page("Home", "Welcome home text", ["/docs/a", "/docs/b"], "h1"),
  [A]: page("A", "Alpha body text", [], "a1"),
  [B]: page("B", "Beta body text", [], "b1"),
});

function rig(routes: Record<string, Route>) {
  const db = openDatabase(":memory:");
  const repo = new Repository(db);
  const hooks: { onFetch?: (url: string) => void; robots: () => Promise<string | null> } = {
    robots: async () => null,
  };
  const extractCalls: string[] = [];
  const fetcher = new FakeFetcher(routes, (url) => hooks.onFetch?.(url));
  const service = new SyncService({
    repo,
    config: testConfig(),
    createFetcher: () => fetcher,
    loadRobots: () => hooks.robots(),
    extract: (html, url, config) => {
      extractCalls.push(url);
      return fakeExtract(html, url, config);
    },
    sleep: async () => {},
  });
  async function run(mode: SyncRequestMode) {
    const result = service.start(mode);
    assert.ok(result.ok, "start should succeed");
    await service.whenIdle();
    const status = service.getStatus();
    assert.ok(status.lastRun, "a finished run must be recorded");
    return { result, status, counts: status.lastRun.counts, run: status.lastRun };
  }
  return { db, repo, fetcher, service, hooks, extractCalls, run };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setImmediate(r));
  assert.ok(check(), "condition was not reached");
}

describe("first synchronization", () => {
  it("indexes every discovered page and records a completed run", async () => {
    const t = rig(baseSite());
    const { result, status, counts, run } = await t.run("auto");
    assert.equal(result.ok && result.mode, "full", "auto picks a full sync when the index is empty");
    assert.deepEqual([counts.added, counts.updated, counts.unchanged, counts.failed, counts.deleted], [3, 0, 0, 0, 0]);
    assert.equal(run.status, "completed");
    assert.equal(run.trigger, "manual");
    assert.equal(status.totals.documents, 3);
    assert.ok(status.lastSuccessAt, "a clean run sets the last successful sync time");
    assert.equal(status.state, "idle");
  });
  it("auto then chooses an incremental sync", async () => {
    const t = rig(baseSite());
    await t.run("auto");
    const second = await t.run("auto");
    assert.equal(second.result.ok && second.result.mode, "incremental");
  });
});

describe("incremental synchronization and unchanged detection", () => {
  it("sends validators and does not reprocess pages the server reports as not modified", async () => {
    const t = rig(baseSite());
    await t.run("full");
    t.fetcher.reset();
    t.extractCalls.length = 0;

    const { counts } = await t.run("incremental");
    assert.deepEqual([counts.added, counts.updated, counts.unchanged], [0, 0, 3]);
    assert.deepEqual(t.extractCalls, [HOME], "only the start page is parsed again");
    const sent = Object.fromEntries(t.fetcher.sentValidators.map((s) => [s.url, s.validators?.etag ?? null]));
    assert.equal(sent[HOME], null, "start page is always fetched in full (it carries the navigation)");
    assert.equal(sent[A], "a1");
    assert.equal(sent[B], "b1");
  });
  it("without validators it re-fetches but still reports unchanged and rewrites nothing", async () => {
    const site = baseSite();
    for (const key of Object.keys(site)) {
      const route = site[key] as { html: string };
      site[key] = { html: route.html };
    }
    const t = rig(site);
    await t.run("full");
    t.extractCalls.length = 0;
    const { counts } = await t.run("incremental");
    assert.deepEqual([counts.added, counts.updated, counts.unchanged], [0, 0, 3]);
    assert.equal(t.extractCalls.length, 3);
  });
});

describe("modified, new and deleted documentation", () => {
  it("detects a modified document and updates its stored content", async () => {
    const t = rig(baseSite());
    await t.run("full");
    t.fetcher.routes[A] = page("A", "Alpha body text, now revised", [], "a2");
    const { counts, status } = await t.run("incremental");
    assert.deepEqual([counts.added, counts.updated, counts.unchanged], [0, 1, 2]);
    assert.ok(t.repo.listDocuments().find((d) => d.url === A)?.cleanedContent.includes("revised"));
    assert.equal(status.totals.documents, 3);
  });
  it("discovers a newly added page from the navigation", async () => {
    const t = rig(baseSite());
    await t.run("full");
    t.fetcher.routes[HOME] = page("Home", "Welcome home text", ["/docs/a", "/docs/b", "/docs/c"], "h2");
    t.fetcher.routes[C] = page("C", "Gamma body text", [], "c1");
    const { counts, status } = await t.run("incremental");
    // Home's text is unchanged (only its navigation grew), so it counts as unchanged.
    assert.deepEqual([counts.added, counts.updated, counts.unchanged], [1, 0, 3]);
    assert.equal(status.totals.documents, 4);
    assert.equal(status.totals.discoveredUrls, 4);
  });
  it("marks a page the source reports gone as deleted, keeps its text, and restores it later", async () => {
    const t = rig(baseSite());
    await t.run("full");

    delete t.fetcher.routes[B];
    const gone = await t.run("incremental");
    assert.equal(gone.counts.deleted, 1);
    assert.equal(gone.counts.failed, 0, "a 404 on an indexed page is a deletion, not a failure");
    assert.equal(gone.status.totals.deleted, 1);
    assert.equal(gone.status.totals.documents, 2);
    assert.ok(!t.repo.listDocuments().some((d) => d.url === B));
    const row = t.db.prepare("SELECT deleted_at, cleaned_content FROM documents WHERE url = ?").get(B) as
      { deleted_at: string | null; cleaned_content: string };
    assert.ok(row.deleted_at, "soft delete: row is still in the database");
    assert.equal(row.cleaned_content, "Beta body text");

    const again = await t.run("incremental");
    assert.equal(again.counts.deleted, 0, "an already-deleted page is not counted twice");
    assert.equal(again.status.totals.deleted, 1);

    t.fetcher.routes[B] = page("B", "Beta body text", [], "b1");
    const back = await t.run("incremental");
    assert.equal(back.counts.updated, 1, "a page that returns is restored");
    assert.equal(back.status.totals.deleted, 0);
    assert.ok(t.repo.listDocuments().some((d) => d.url === B));
  });
});

describe("temporary failures and retry", () => {
  const outages: Array<[string, FetchError]> = [
    ["network error", new FetchError("network", "Network error: ECONNRESET")],
    ["timeout", new FetchError("timeout", "Timed out after 20000 ms")],
    ["HTTP 503", new FetchError("http", "HTTP 503 Service Unavailable", 503)],
    ["HTTP 429", new FetchError("http", "HTTP 429 Too Many Requests", 429)],
  ];

  for (const [label, error] of outages) {
    it(`a ${label} never removes an indexed document`, async () => {
      const t = rig(baseSite());
      const first = await t.run("full");
      t.fetcher.routes[A] = { error };

      const { counts, status, run } = await t.run("incremental");
      assert.equal(counts.failed, 1);
      assert.equal(counts.deleted, 0);
      assert.equal(run.status, "completed_with_errors");
      assert.equal(status.totals.documents, 3, "indexed copy is kept");
      assert.equal(status.totals.deleted, 0);
      assert.ok(t.repo.listDocuments().some((d) => d.url === A));
      assert.equal(status.lastSuccessAt, first.status.lastSuccessAt, "a run with failures is not a successful sync");
      assert.equal(status.failedPages[0]?.url, A);
      assert.match(status.failedPages[0]?.error ?? "", new RegExp(error.message.split(" ")[0] ?? ""));
    });
  }

  it("retry re-checks only the failed pages and clears them once the source recovers", async () => {
    const t = rig(baseSite());
    await t.run("full");
    t.fetcher.routes[A] = { error: new FetchError("network", "Network error: ECONNRESET") };
    await t.run("incremental");

    t.fetcher.routes[A] = page("A", "Alpha body text", [], "a1");
    t.fetcher.reset();
    const { counts, status, run } = await t.run("retry");
    assert.deepEqual(t.fetcher.requested, [A], "only the failed URL is requested");
    assert.equal(counts.failed, 0);
    assert.equal(counts.unchanged, 1);
    assert.equal(status.totals.failedOutstanding, 0);
    assert.equal(run.status, "completed");
  });
  it("retry keeps a page failed (and its copy) while the outage continues", async () => {
    const t = rig(baseSite());
    await t.run("full");
    t.fetcher.routes[A] = { error: new FetchError("timeout", "Timed out after 20000 ms") };
    await t.run("incremental");
    const again = await t.run("retry");
    assert.equal(again.counts.failed, 1);
    assert.equal(again.status.totals.failedOutstanding, 1);
    assert.equal(again.status.totals.documents, 3);
  });
  it("refuses to start a retry when nothing has failed", async () => {
    const t = rig(baseSite());
    await t.run("full");
    assert.deepEqual(t.service.start("retry"), { ok: false, reason: "nothing-to-retry" });
  });
  it("a failed page on the very first sync is recorded, not silently dropped", async () => {
    const site = baseSite();
    site[B] = { error: new FetchError("http", "HTTP 500 Server Error", 500) };
    const t = rig(site);
    const { counts, status } = await t.run("full");
    assert.deepEqual([counts.added, counts.failed], [2, 1]);
    assert.equal(status.failedPages[0]?.httpStatus, 500);
  });
  it("an unreadable robots.txt fails the run and leaves the index untouched", async () => {
    const t = rig(baseSite());
    await t.run("full");
    t.hooks.robots = async () => { throw new Error("HTTP 503"); };
    t.fetcher.reset();
    const { run, status } = await t.run("full");
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /robots\.txt/);
    assert.equal(t.fetcher.requested.length, 0);
    assert.equal(status.totals.documents, 3);
  });
});

describe("pause, resume, cancel", () => {
  it("pauses between pages, makes no requests while paused, then resumes to completion", async () => {
    const t = rig(baseSite());
    t.hooks.onFetch = (url) => { if (url === HOME) t.service.pause(); };
    assert.equal(t.service.pause(), false, "nothing to pause while idle");
    const started = t.service.start("full");
    assert.ok(started.ok);

    await until(() => t.service.getStatus().state === "paused");
    await settle();
    assert.equal(t.fetcher.requested.length, 1, "no further requests while paused");
    assert.equal(t.service.getStatus().current?.counts.added, 1);
    assert.equal(t.service.resume(), true);
    assert.equal(t.service.resume(), false, "already resumed");

    await t.service.whenIdle();
    const status = t.service.getStatus();
    assert.equal(status.lastRun?.status, "completed");
    assert.equal(status.lastRun?.counts.added, 3);
    assert.equal(t.fetcher.requested.length, 3);
  });
  it("cancelling a paused run stops it, keeps what was saved, and a later run finishes the rest", async () => {
    const t = rig(baseSite());
    t.hooks.onFetch = (url) => { if (url === HOME) t.service.pause(); };
    t.service.start("full");
    await until(() => t.service.getStatus().state === "paused");

    assert.equal(t.service.cancel(), true);
    await t.service.whenIdle();
    let status = t.service.getStatus();
    assert.equal(status.state, "idle");
    assert.equal(status.lastRun?.status, "cancelled");
    assert.equal(status.totals.documents, 1);
    assert.equal(status.lastSuccessAt, null, "a cancelled run is not a successful sync");

    t.hooks.onFetch = undefined;
    const rest = await t.run("incremental");
    assert.deepEqual([rest.counts.added, rest.counts.unchanged], [2, 1]);
    status = t.service.getStatus();
    assert.equal(status.totals.documents, 3);
  });
  it("rejects a second start while one is running", async () => {
    const t = rig(baseSite());
    assert.ok(t.service.start("full").ok);
    assert.deepEqual(t.service.start("incremental"), { ok: false, reason: "already-running" });
    await t.service.whenIdle();
  });
});

describe("real-time statistics and run history", () => {
  it("exposes live counters and progress mid-run, taken from real crawl events", async () => {
    const t = rig(baseSite());
    const seen: { current: ReturnType<typeof t.service.getStatus>["current"] } = { current: null };
    t.hooks.onFetch = (url) => { if (url === B) seen.current = t.service.getStatus().current; };
    await t.run("full");
    const s = seen.current;
    assert.ok(s, "a run was in progress when B was fetched");
    assert.equal(s.counts.added, 2, "home and A were already added");
    assert.deepEqual([s.progress.processed, s.progress.total, s.progress.currentUrl], [2, 3, B]);
    assert.equal(s.progress.percent, 67);
  });
  it("persists every run with its trigger, mode and counts", async () => {
    const t = rig(baseSite());
    await t.run("full");
    await t.run("incremental");
    const runs = t.repo.listRuns();
    assert.deepEqual(runs.map((r) => r.mode), ["incremental", "full"]);
    assert.ok(runs.every((r) => r.finishedAt && r.trigger === "manual"));
    assert.equal(runs[1]?.counts.added, 3);
  });
  it("activity log entries carry the run id and say what happened to each page", async () => {
    const t = rig(baseSite());
    const { run } = await t.run("full");
    const messages = t.repo.getLogs(100, run.id).map((l) => l.message);
    assert.equal(messages.filter((m) => m.startsWith("New page added")).length, 3);
    assert.ok(t.repo.getLogs(100, "no-such-run").length === 0);
  });
  it("closes runs left 'running' by a stopped backend as interrupted", () => {
    const t = rig(baseSite());
    t.repo.createRun("stale-run", "full", "scheduled", new Date().toISOString());
    assert.equal(t.repo.recoverInterruptedRuns(), 1);
    const run = t.repo.listRuns().find((r) => r.id === "stale-run");
    assert.equal(run?.status, "interrupted");
    assert.equal(t.repo.recoverInterruptedRuns(), 0);
  });
});
