import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FetchError, fetchStatic, withRetries } from "@/server/scraper/fetcher";
import { RateLimiter } from "@/server/scraper/rate-limiter";
import { parseRobots } from "@/server/scraper/robots";

const AGENT = "GTPSAssistantBot";

describe("robots.txt", () => {
  it("allows everything when the file has no matching rules", () => {
    const p = parseRobots("User-agent: *\nDisallow:\n", AGENT);
    assert.ok(p.isAllowed("https://a.test/docs/x"));
  });
  it("honours Disallow and the longest matching Allow", () => {
    const p = parseRobots(
      "User-agent: *\nDisallow: /docs/private\nAllow: /docs/private/open\n",
      AGENT,
    );
    assert.ok(!p.isAllowed("https://a.test/docs/private/secret"));
    assert.ok(p.isAllowed("https://a.test/docs/private/open/page"));
    assert.ok(p.isAllowed("https://a.test/docs/player"));
  });
  it("prefers a group that names our agent over the wildcard group", () => {
    const p = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: GTPSAssistantBot\nDisallow: /admin\n",
      AGENT,
    );
    assert.ok(p.isAllowed("https://a.test/docs"));
    assert.ok(!p.isAllowed("https://a.test/admin"));
  });
  it("supports wildcards and end anchors", () => {
    const p = parseRobots("User-agent: *\nDisallow: /*.json$\n", AGENT);
    assert.ok(!p.isAllowed("https://a.test/docs/x.json"));
    assert.ok(p.isAllowed("https://a.test/docs/x.json5"));
  });
  it("reads Crawl-delay and Sitemap, ignoring comments", () => {
    const p = parseRobots("# hi\nUser-agent: *\nCrawl-delay: 2.5 # slow\nSitemap: https://a.test/s.xml\n", AGENT);
    assert.equal(p.crawlDelayMs, 2500);
    assert.deepEqual(p.sitemaps, ["https://a.test/s.xml"]);
  });
});

describe("RateLimiter", () => {
  it("waits only for the remaining part of the delay", async () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const limiter = new RateLimiter(500, async (ms) => { sleeps.push(ms); clock += ms; }, () => clock);
    await limiter.wait(); // first call never waits
    clock += 200;
    await limiter.wait();
    assert.deepEqual(sleeps, [300]);
  });
});

/**
 * A fetch that never answers on its own and rejects when its signal aborts,
 * like the real one. A ref'd interval stands in for the open socket, because
 * AbortSignal.timeout() timers do not keep the event loop alive by themselves.
 */
function hangingFetch(): typeof fetch {
  return ((_url: string, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      const fail = () => { clearInterval(keepAlive); reject(new DOMException("aborted", "AbortError")); };
      if (init?.signal?.aborted) return fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
    })) as unknown as typeof fetch;
}

describe("fetchStatic error handling", () => {
  const cfg = { userAgent: "t", timeoutMs: 1000 };
  const respond = (status: number, type = "text/html", text = "<p>ok</p>") =>
    (async () => new Response(text, { status, headers: { "content-type": type } })) as typeof fetch;

  it("returns html for a 200 response", async () => {
    const page = await fetchStatic("https://a.test/", cfg, undefined, respond(200));
    assert.equal(page.html, "<p>ok</p>");
  });
  it("classifies HTTP errors and marks only 429/5xx retryable", async () => {
    await assert.rejects(fetchStatic("https://a.test/", cfg, undefined, respond(404)), (e: unknown) =>
      e instanceof FetchError && e.kind === "http" && e.httpStatus === 404 && !e.retryable);
    await assert.rejects(fetchStatic("https://a.test/", cfg, undefined, respond(503)), (e: unknown) =>
      e instanceof FetchError && e.retryable);
  });
  it("rejects non-HTML content", async () => {
    await assert.rejects(fetchStatic("https://a.test/", cfg, undefined, respond(200, "application/pdf")),
      (e: unknown) => e instanceof FetchError && e.kind === "not-html");
  });
  it("classifies network failures", async () => {
    const failing = (async () => { throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") }); }) as typeof fetch;
    await assert.rejects(fetchStatic("https://a.test/", cfg, undefined, failing), (e: unknown) =>
      e instanceof FetchError && e.kind === "network" && /ECONNRESET/.test(e.message));
  });
  it("classifies timeouts", async () => {
    const hang = hangingFetch();
    await assert.rejects(fetchStatic("https://a.test/", { userAgent: "t", timeoutMs: 30 }, undefined, hang),
      (e: unknown) => e instanceof FetchError && e.kind === "timeout");
  });
  it("reports cancellation as aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const hang = hangingFetch();
    await assert.rejects(fetchStatic("https://a.test/", cfg, controller.signal, hang),
      (e: unknown) => e instanceof FetchError && e.kind === "aborted");
  });
});

describe("withRetries", () => {
  it("retries retryable errors then succeeds", async () => {
    let calls = 0;
    const result = await withRetries(async () => {
      calls += 1;
      if (calls < 3) throw new FetchError("network", "boom");
      return "ok";
    }, { maxRetries: 2, backoffMs: 1, sleep: async () => {} });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });
  it("does not retry a 404 and gives up after maxRetries", async () => {
    let calls = 0;
    await assert.rejects(withRetries(async () => { calls += 1; throw new FetchError("http", "x", 404); },
      { maxRetries: 3, backoffMs: 1, sleep: async () => {} }));
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(withRetries(async () => { calls += 1; throw new FetchError("timeout", "x"); },
      { maxRetries: 2, backoffMs: 1, sleep: async () => {} }));
    assert.equal(calls, 3);
  });
});
