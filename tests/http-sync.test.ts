/**
 * End-to-end sync over real HTTP against a local server: real fetch, real
 * ETag/304 handling, real retries, real robots.txt requests. The pages are
 * JSON bodies served as text/html and parsed by the fake extractor, so this
 * does not exercise Cheerio (see extractor.test.ts for that).
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { createConfig } from "@/server/scraper/config";
import { fetchStatic, withRetries, type PageFetcher } from "@/server/scraper/fetcher";
import { SyncService } from "@/server/sync/sync-service";
import type { SyncRequestMode } from "@/types/sync";
import { body, fakeExtract } from "./helpers";

interface Page {
  text: string;
  links?: string[];
  etag?: string;
  /** Non-200 status to answer with instead of the page. */
  status?: number;
}
interface Hit { path: string; status: number; conditional: boolean }

async function startServer(pages: Record<string, Page>, robots: { status: number; text?: string } = { status: 404 }) {
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    const conditional = Boolean(req.headers["if-none-match"]);
    const done = (status: number, headers: Record<string, string> = {}, text = "") => {
      hits.push({ path, status, conditional });
      res.writeHead(status, headers);
      res.end(text);
    };
    if (path === "/robots.txt") return done(robots.status, { "content-type": "text/plain" }, robots.text ?? "");
    const page = pages[path];
    if (!page) return done(404, { "content-type": "text/html" }, "not found");
    if (page.status) return done(page.status, { "content-type": "text/html" }, "error");
    if (page.etag && req.headers["if-none-match"] === page.etag) return done(304, { etag: page.etag });
    return done(
      200,
      { "content-type": "text/html", ...(page.etag ? { etag: page.etag } : {}) },
      body({ title: path, text: page.text, links: page.links }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    pages,
    robots,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function rig(pages: Record<string, Page>, robots?: { status: number; text?: string }) {
  const server = await startServer(pages, robots);
  const config = createConfig({
    startUrl: `${server.origin}/docs`,
    requestDelayMs: 0,
    maxRetries: 1,
    retryBackoffMs: 1,
    timeoutMs: 2000,
    minContentLength: 5,
  });
  const fetcher: PageFetcher = {
    fetchPage: (url, signal, validators) =>
      withRetries(() => fetchStatic(url, config, signal, fetch, validators ?? null), {
        maxRetries: config.maxRetries,
        backoffMs: 1,
        signal,
        sleep: async () => {},
      }),
    close: async () => {},
  };
  const repo = new Repository(openDatabase(":memory:"));
  const extractCalls: string[] = [];
  const service = new SyncService({
    repo,
    config,
    createFetcher: () => fetcher,
    // loadRobots left unset on purpose: the real robots.txt request is exercised.
    extract: (html, url, cfg) => {
      extractCalls.push(url);
      return fakeExtract(html, url, cfg);
    },
    sleep: async () => {},
  });
  async function run(mode: SyncRequestMode) {
    server.hits.length = 0;
    extractCalls.length = 0;
    assert.ok(service.start(mode).ok);
    await service.whenIdle();
    const status = service.getStatus();
    assert.ok(status.lastRun);
    return { status, counts: status.lastRun.counts, run: status.lastRun };
  }
  const hitsFor = (path: string) => server.hits.filter((h) => h.path === path);
  return { server, repo, service, run, extractCalls, hitsFor, config };
}

const site = (): Record<string, Page> => ({
  "/docs": { text: "Welcome home text", links: ["/docs/a", "/docs/b"], etag: '"h1"' },
  "/docs/a": { text: "Alpha body text", etag: '"a1"' },
  "/docs/b": { text: "Beta body text", etag: '"b1"' },
});

describe("sync over real HTTP", () => {
  it("first sync fetches robots.txt, crawls the site and stores the ETags", async () => {
    const t = await rig(site());
    try {
      const { counts, run } = await t.run("auto");
      assert.deepEqual([counts.added, counts.failed], [3, 0]);
      assert.equal(run.status, "completed");
      assert.equal(t.server.hits.filter((h) => h.path === "/robots.txt").length, 1, "robots.txt was really requested");
      assert.equal(t.repo.getValidators(`${t.server.origin}/docs/a`)?.etag, '"a1"');
    } finally { await t.server.close(); }
  });

  it("incremental sync gets real 304 responses and does not reprocess those pages", async () => {
    const t = await rig(site());
    try {
      await t.run("full");
      const { counts } = await t.run("incremental");
      assert.deepEqual([counts.added, counts.updated, counts.unchanged], [0, 0, 3]);
      assert.deepEqual(t.hitsFor("/docs/a"), [{ path: "/docs/a", status: 304, conditional: true }]);
      assert.deepEqual(t.hitsFor("/docs/b"), [{ path: "/docs/b", status: 304, conditional: true }]);
      assert.equal(t.hitsFor("/docs")[0]?.conditional, false, "start page is fetched in full");
      assert.deepEqual(t.extractCalls, [`${t.server.origin}/docs`], "only the start page was parsed again");
    } finally { await t.server.close(); }
  });

  it("detects a modified page when the server returns a new ETag and body", async () => {
    const t = await rig(site());
    try {
      await t.run("full");
      t.server.pages["/docs/a"] = { text: "Alpha body text, revised", etag: '"a2"' };
      const { counts } = await t.run("incremental");
      assert.deepEqual([counts.updated, counts.unchanged], [1, 2]);
      assert.equal(t.hitsFor("/docs/a")[0]?.status, 200);
    } finally { await t.server.close(); }
  });

  it("detects a new page and a page the server reports gone (404 and 410)", async () => {
    const t = await rig(site());
    try {
      await t.run("full");
      t.server.pages["/docs"] = { text: "Welcome home text", links: ["/docs/a", "/docs/b", "/docs/c"], etag: '"h2"' };
      t.server.pages["/docs/c"] = { text: "Gamma body text", etag: '"c1"' };
      t.server.pages["/docs/a"] = { text: "", status: 404 };
      t.server.pages["/docs/b"] = { text: "", status: 410 };
      const { counts, status } = await t.run("incremental");
      assert.deepEqual([counts.added, counts.deleted, counts.failed], [1, 2, 0]);
      assert.equal(status.totals.documents, 2);
      assert.equal(status.totals.deleted, 2);
    } finally { await t.server.close(); }
  });

  it("a real 503 is retried, then recorded as failed while the indexed copy is kept", async () => {
    const t = await rig(site());
    try {
      await t.run("full");
      t.server.pages["/docs/a"] = { text: "", status: 503 };
      const { counts, run, status } = await t.run("incremental");
      assert.equal(t.hitsFor("/docs/a").length, 2, "one attempt plus one retry");
      assert.deepEqual([counts.failed, counts.deleted], [1, 0]);
      assert.equal(run.status, "completed_with_errors");
      assert.equal(status.totals.documents, 3);
      assert.match(status.failedPages[0]?.error ?? "", /HTTP 503/);

      // The outage ends: retry re-checks only the failed page and clears it.
      t.server.pages["/docs/a"] = { text: "Alpha body text", etag: '"a1"' };
      const retried = await t.run("retry");
      assert.deepEqual(t.server.hits.filter((h) => h.path !== "/robots.txt").map((h) => h.path), ["/docs/a"]);
      assert.equal(retried.counts.failed, 0);
      assert.equal(retried.status.totals.failedOutstanding, 0);
    } finally { await t.server.close(); }
  });

  it("when the whole server is down the run fails and the index is left untouched", async () => {
    const t = await rig(site());
    await t.run("full");
    await t.server.close(); // connection refused from now on
    const { run, status } = await t.run("incremental");
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /robots\.txt/);
    assert.equal(status.totals.documents, 3);
    assert.equal(status.totals.deleted, 0);
  });

  it("refuses to crawl when robots.txt answers 503", async () => {
    const t = await rig(site(), { status: 503 });
    try {
      const { run, status } = await t.run("full");
      assert.equal(run.status, "failed");
      assert.equal(t.server.hits.filter((h) => h.path !== "/robots.txt").length, 0, "no page was requested");
      assert.equal(status.totals.documents, 0);
    } finally { await t.server.close(); }
  });

  it("never requests a path that robots.txt disallows", async () => {
    const t = await rig(site(), { status: 200, text: "User-agent: *\nDisallow: /docs/b\n" });
    try {
      const { counts } = await t.run("full");
      assert.equal(t.hitsFor("/docs/b").length, 0);
      assert.deepEqual([counts.added, counts.blocked], [2, 1]);
    } finally { await t.server.close(); }
  });
});
