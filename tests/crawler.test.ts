import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Crawler } from "@/server/scraper/crawler";
import { FetchError } from "@/server/scraper/fetcher";
import { BASE, FakeFetcher, body, fakeExtract, freshRepo, testConfig } from "./helpers";

const cfg = testConfig();
const u = (path: string) => `${BASE}${path}`;

function crawler(fetcher: FakeFetcher, repo: ReturnType<typeof freshRepo>["repo"], robots: string | null = null) {
  return new Crawler({
    config: cfg, repo, fetcher,
    loadRobots: async () => robots,
    extract: fakeExtract,
    sleep: async () => {},
  });
}

describe("crawler: discovery", () => {
  it("follows internal links breadth-first and ignores external ones", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/a", "/docs/b", "https://other.test/x"] }) },
      [u("/docs/a")]: { html: body({ title: "A", text: "Page A text", links: ["/docs/b", "/docs/c"] }) },
      [u("/docs/b")]: { html: body({ title: "B", text: "Page B text" }) },
      [u("/docs/c")]: { html: body({ title: "C", text: "Page C text" }) },
    });
    const summary = await crawler(fetcher, repo).run("full");
    assert.deepEqual(fetcher.requested, [u("/docs"), u("/docs/a"), u("/docs/b"), u("/docs/c")]);
    assert.equal(summary.counts.added, 4);
    assert.equal(repo.getStats().discovered, 4);
    assert.equal(repo.listDocuments().length, 4);
  });
  it("never requests the same URL twice, even when linked many times", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/a", "/docs/a/", "/docs/a#x", "/docs/a?utm_source=z"] }) },
      [u("/docs/a")]: { html: body({ title: "A", text: "Page A text", links: ["/docs"] }) },
    });
    await crawler(fetcher, repo).run("full");
    assert.equal(fetcher.requested.filter((x) => x === u("/docs/a")).length, 1);
    assert.equal(fetcher.requested.length, 2);
  });
});

describe("crawler: content problems", () => {
  it("marks identical content on a different URL as duplicate, not a second document", async () => {
    const { repo } = freshRepo();
    const same = body({ title: "Same", text: "exactly the same text", links: ["/docs/copy"] });
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: same },
      [u("/docs/copy")]: { html: body({ title: "Same", text: "exactly the same text" }) },
    });
    const summary = await crawler(fetcher, repo).run("full");
    assert.equal(summary.counts.duplicates, 1);
    assert.equal(repo.listDocuments().length, 1);
    assert.equal(repo.getStats().duplicates, 1);
  });
  it("records empty pages as failed instead of ignoring them", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/empty"] }) },
      [u("/docs/empty")]: { html: body({ title: "Empty", text: "" }) },
    });
    const summary = await crawler(fetcher, repo).run("full");
    assert.equal(summary.counts.failed, 1);
    assert.match(repo.listFailed()[0]?.error ?? "", /Empty or invalid content/);
  });
  it("records invalid content (extractor throws) as failed", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/bad"] }) },
      [u("/docs/bad")]: { html: "{not json" },
    });
    const summary = await crawler(fetcher, repo).run("full");
    assert.equal(summary.counts.failed, 1);
    assert.equal(summary.counts.added, 1);
  });
  it("rejects redirects that leave the documentation area", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { redirectTo: "https://evil.test/login", html: body({ title: "x", text: "should not be saved" }) },
    });
    const summary = await crawler(fetcher, repo).run("full");
    assert.equal(summary.counts.failed, 1);
    assert.equal(repo.listDocuments().length, 0);
  });
});

describe("crawler: failure handling and retry", () => {
  const routes = (fixed: boolean) => ({
    [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/a", "/docs/b", "/docs/c", "/docs/gone"] }) },
    [u("/docs/a")]: { error: new FetchError("http", "HTTP 500 Server Error", 500) },
    [u("/docs/b")]: { error: new FetchError("timeout", "Timed out after 20000 ms") },
    [u("/docs/c")]: { error: new FetchError("network", "Network error: ECONNRESET") },
    ...(fixed ? { [u("/docs/a")]: { html: body({ title: "A", text: "Page A recovered" }) } } : {}),
  });

  it("logs each failure with its error and never aborts the run", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher(routes(false));
    const summary = await crawler(fetcher, repo).run("full");
    assert.equal(summary.counts.added, 1);
    assert.equal(summary.counts.failed, 4); // a (500), b (timeout), c (network), gone (404)
    const failed = repo.listFailed();
    assert.equal(failed.find((f) => f.url === u("/docs/a"))?.httpStatus, 500);
    assert.match(failed.find((f) => f.url === u("/docs/b"))?.error ?? "", /Timed out/);
    assert.equal(failed.find((f) => f.url === u("/docs/gone"))?.httpStatus, 404);
    assert.ok(repo.getLogs().filter((l) => l.level === "error").length >= 4);
  });
  it("retry mode only re-requests failed pages and fixes them", async () => {
    const { repo } = freshRepo();
    await crawler(new FakeFetcher(routes(false)), repo).run("full");
    const second = new FakeFetcher(routes(true));
    const summary = await crawler(second, repo).run("retry");
    assert.ok(!second.requested.includes(u("/docs")), "scraped page must not be re-requested");
    assert.equal(second.requested.length, 4);
    assert.equal(summary.counts.added, 1);
    assert.equal(repo.getStats().failed, 3);
  });
});

describe("crawler: robots.txt and cancellation", () => {
  it("does not request URLs disallowed by robots.txt and records them as blocked", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/private", "/docs/open"] }) },
      [u("/docs/open")]: { html: body({ title: "Open", text: "Open page text" }) },
      [u("/docs/private")]: { html: body({ title: "Private", text: "must never be fetched" }) },
    });
    const summary = await crawler(fetcher, repo, "User-agent: *\nDisallow: /docs/private\n").run("full");
    assert.ok(!fetcher.requested.includes(u("/docs/private")));
    assert.equal(summary.counts.blocked, 1);
    assert.equal(repo.getStats().blocked, 1);
  });
  it("refuses to crawl when robots.txt cannot be read", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({ [u("/docs")]: { html: body({ title: "x", text: "never fetched" }) } });
    const c = new Crawler({ config: cfg, repo, fetcher, extract: fakeExtract, sleep: async () => {},
      loadRobots: async () => { throw new Error("HTTP 503"); } });
    await c.run("full");
    assert.equal(fetcher.requested.length, 0);
    assert.ok(repo.getLogs().some((l) => l.level === "error" && /robots/.test(l.message)));
  });
  it("stops promptly when cancelled and keeps pages already saved", async () => {
    const { repo } = freshRepo();
    const controller = new AbortController();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/a", "/docs/b"] }) },
      [u("/docs/a")]: { html: body({ title: "A", text: "Page A text" }) },
      [u("/docs/b")]: { html: body({ title: "B", text: "Page B text" }) },
    }, (url) => { if (url === u("/docs/a")) controller.abort(); });
    const summary = await crawler(fetcher, repo).run("full", controller.signal);
    assert.equal(summary.cancelled, true);
    assert.ok(!fetcher.requested.includes(u("/docs/b")));
    assert.equal(repo.getStats().pending, 1);
  });
  it("stops at the maxPages safety limit", async () => {
    const { repo } = freshRepo();
    const fetcher = new FakeFetcher({
      [u("/docs")]: { html: body({ title: "Home", text: "Welcome home", links: ["/docs/a", "/docs/b"] }) },
      [u("/docs/a")]: { html: body({ title: "A", text: "Page A text" }) },
      [u("/docs/b")]: { html: body({ title: "B", text: "Page B text" }) },
    });
    const c = new Crawler({ config: testConfig({ maxPages: 2 }), repo, fetcher, extract: fakeExtract,
      sleep: async () => {}, loadRobots: async () => null });
    await c.run("full");
    assert.equal(fetcher.requested.length, 2);
  });
});
