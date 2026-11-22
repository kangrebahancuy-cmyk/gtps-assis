/**
 * Pages rendered by the crawler's Chromium (HybridFetcher in "browser" mode) run the site's own scripts, so they are
 * confined: only the documentation area may be navigated to, and sub-requests may only go to the documentation
 * origin, approved domains and the user's extra domains. "inner" plays an internal service that must never be hit.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";

import { chromium } from "./support/browser";
import { HybridFetcher } from "../../src/server/scraper/browser-fetcher";
import { createConfig } from "../../src/server/scraper/config";

const listen = async (handler: Parameters<typeof createServer>[1]) => {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

let inner: { server: Server; origin: string };
let site: { server: Server; origin: string };
const innerHits: string[] = [];
const siteHits: string[] = [];

before(async () => {
  inner = await listen((req, res) => {
    innerHits.push(req.url ?? "");
    res.setHeader("content-type", "text/html");
    res.end("<html><body>INTERNAL</body></html>");
  });
  site = await listen((req, res) => {
    siteHits.push(req.url ?? "");
    const url = req.url ?? "";
    if (url === "/docs/page") {
      res.setHeader("content-type", "text/html");
      return res.end(`<html><body><h1>Rendered page</h1>
        <img src="${inner.origin}/pixel.png"><script src="${inner.origin}/x.js"></script>
        <img src="/docs/own.png">
        <script>fetch(${JSON.stringify(inner.origin + "/steal")}).catch(() => {}); document.body.append(" scripted")</script></body></html>`);
    }
    if (url === "/docs/redirect") {
      res.writeHead(302, { location: `${inner.origin}/admin` });
      return res.end();
    }
    if (url === "/docs/moved") {
      res.writeHead(301, { location: "/docs/page2" });
      return res.end();
    }
    if (url === "/docs/page2") {
      res.setHeader("content-type", "text/html");
      return res.end("<html><body><h1>Moved page</h1></body></html>");
    }
    if (url === "/docs/js-redirect") {
      res.setHeader("content-type", "text/html");
      return res.end(`<html><body><script>location.href = ${JSON.stringify(inner.origin + "/js")}</script>waiting</body></html>`);
    }
    res.statusCode = 404;
    res.end("no");
  });
});
after(async () => {
  await new Promise((r) => inner.server.close(r));
  site.server.closeAllConnections();
  await new Promise((r) => site.server.close(r));
});

const fetcher = () => new HybridFetcher(createConfig({ startUrl: `${site.origin}/docs`, renderMode: "browser", timeoutMs: 8000 }), () => [], () => chromium.launch());

describe("rendered pages are confined", () => {
  it("scripts run, but requests to other origins (internal services) are blocked", async () => {
    innerHits.length = 0;
    const f = fetcher();
    try {
      const page = await f.fetchPage(`${site.origin}/docs/page`);
      assert.equal(page.rendered, "browser");
      assert.match(page.html, /Rendered page/);
      assert.match(page.html, /scripted/, "the page's own script still ran");
      assert.ok(siteHits.includes("/docs/own.png"), "same-origin sub-requests are allowed");
    } finally {
      await f.close();
    }
    assert.deepEqual(innerHits, [], "the internal service received nothing (image, script and fetch were all blocked)");
  });

  it("a redirect or a script navigating out of the documentation area is refused", async () => {
    innerHits.length = 0;
    for (const path of ["/docs/redirect", "/docs/js-redirect"]) {
      const f = fetcher();
      try {
        await assert.rejects(f.fetchPage(`${site.origin}${path}`), (e: Error) => {
          assert.equal((e as { kind?: string }).kind, "browser", path);
          return true;
        }, path);
      } catch (error) {
        // js-redirect: the navigation is blocked but the page itself may load; then it must at least not have left.
        if (path !== "/docs/js-redirect") throw error;
      } finally {
        await f.close();
      }
    }
    assert.deepEqual(innerHits, []);
  });

  it("a redirect that stays inside the documentation area still works", async () => {
    const f = fetcher();
    try {
      const page = await f.fetchPage(`${site.origin}/docs/moved`);
      assert.match(page.html, /Moved page/);
      assert.equal(page.finalUrl, `${site.origin}/docs/page2`);
    } finally {
      await f.close();
    }
  });

  it("refuses to render an address outside the documentation area at all", async () => {
    innerHits.length = 0;
    const f = fetcher();
    try {
      await assert.rejects(f.fetchPage(`${inner.origin}/anything`), /not an allowed documentation address/);
    } finally {
      await f.close();
    }
    assert.deepEqual(innerHits, []);
  });
});
