/**
 * The crawler must never send a request to an address it is not allowed to read, even when an approved site
 * redirects there. Real HTTP servers on 127.0.0.1: "site" plays the documentation site and "inner" plays an internal
 * service (a metadata endpoint, an admin panel on localhost) that must never be contacted.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, describe, it } from "node:test";

import { createConfig } from "../src/server/scraper/config";
import { defaultLoadRobots } from "../src/server/scraper/crawler";
import { DEFAULT_MAX_PAGE_BYTES, fetchStatic, FetchError, MAX_REDIRECTS, readBodyCapped } from "../src/server/scraper/fetcher";
import { isPrivateHost } from "../src/lib/docs-source";
import { isDocumentationUrl, normalizeUrl } from "../src/server/scraper/url";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const listen = async (handler: Handler): Promise<{ server: Server; origin: string }> => {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

let inner: { server: Server; origin: string };
let innerHits: string[] = [];
let site: { server: Server; origin: string };
let siteHandler: Handler = (_req, res) => res.end("ok");

before(async () => {
  inner = await listen((req, res) => {
    innerHits.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "text/html");
    res.end("<html><body>INTERNAL SECRET</body></html>");
  });
  site = await listen((req, res) => siteHandler(req, res));
});
after(async () => {
  await new Promise((r) => inner.server.close(r));
  site.server.closeAllConnections();
  await new Promise((r) => site.server.close(r));
});
afterEach(() => {
  innerHits = [];
});

const config = () => createConfig({ startUrl: `${site.origin}/docs`, timeoutMs: 3000 });
const guard = () => {
  const c = config();
  return { allow: (u: string) => { const n = normalizeUrl(u); return n !== null && isDocumentationUrl(n, c); } };
};
const html = (res: ServerResponse, body = "<html><body>fine</body></html>") => {
  res.setHeader("content-type", "text/html");
  res.end(body);
};
const redirect = (res: ServerResponse, to: string, status = 302) => {
  res.writeHead(status, { location: to });
  res.end();
};

describe("redirects are checked before they are followed", () => {
  it("an approved site redirecting to an internal service never reaches that service", async () => {
    siteHandler = (_req, res) => redirect(res, `${inner.origin}/admin`);
    await assert.rejects(fetchStatic(`${site.origin}/docs/x`, config(), undefined, fetch, null, guard()), (e: FetchError) => {
      assert.equal(e.kind, "http");
      assert.match(e.message, /Redirected outside documentation area/);
      assert.equal(e.retryable, false);
      return true;
    });
    assert.deepEqual(innerHits, [], "the internal service must not receive any request");
  });

  it("the same is true for every redirect status, relative redirects outside the area and protocol-relative redirects", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      siteHandler = (_req, res) => redirect(res, `${inner.origin}/s${status}`, status);
      await assert.rejects(fetchStatic(`${site.origin}/docs/x`, config(), undefined, fetch, null, guard()), /outside documentation area/);
    }
    siteHandler = (_req, res) => redirect(res, "/admin"); // same host, outside /docs
    await assert.rejects(fetchStatic(`${site.origin}/docs/x`, config(), undefined, fetch, null, guard()), /outside documentation area/);
    siteHandler = (_req, res) => redirect(res, `//${inner.origin.replace("http://", "")}/pt`);
    await assert.rejects(fetchStatic(`${site.origin}/docs/x`, config(), undefined, fetch, null, guard()), /outside documentation area/);
    assert.deepEqual(innerHits, []);
  });

  it("a redirect chain inside the documentation area still works and reports the final address", async () => {
    siteHandler = (req, res) => {
      if (req.url === "/docs/a") return redirect(res, "/docs/b", 301);
      if (req.url === "/docs/b") return redirect(res, `${site.origin}/docs/c`, 308);
      return html(res, "<html><body>final page</body></html>");
    };
    const page = await fetchStatic(`${site.origin}/docs/a`, config(), undefined, fetch, null, guard());
    assert.equal(page.finalUrl, `${site.origin}/docs/c`);
    assert.match(page.html, /final page/);
  });

  it("refuses redirect loops, redirects without a target, and non-web protocols", async () => {
    let n = 0;
    siteHandler = (_req, res) => redirect(res, `/docs/loop${n++}`);
    await assert.rejects(fetchStatic(`${site.origin}/docs/start`, config(), undefined, fetch, null, guard()), /Too many redirects/);
    assert.equal(n, MAX_REDIRECTS + 1);
    siteHandler = (_req, res) => { res.writeHead(302); res.end(); };
    await assert.rejects(fetchStatic(`${site.origin}/docs/x`, config(), undefined, fetch, null, guard()), /without a Location/);
    for (const target of ["file:///etc/passwd", "ftp://127.0.0.1/x", "javascript:alert(1)", "gopher://127.0.0.1:6379/_x"]) {
      siteHandler = (_req, res) => redirect(res, target);
      await assert.rejects(fetchStatic(`${site.origin}/docs/x`, config(), undefined, fetch, null, guard()), FetchError, target);
    }
  });

  it("refuses to start from an address outside the area", async () => {
    await assert.rejects(fetchStatic(`${inner.origin}/anything`, config(), undefined, fetch, null, guard()), /not an allowed documentation address/);
    assert.deepEqual(innerHits, []);
  });

  it("robots.txt may move within the site but never to another host", async () => {
    siteHandler = (req, res) => (req.url === "/robots.txt" ? redirect(res, `${inner.origin}/robots.txt`) : html(res));
    await assert.rejects(defaultLoadRobots(site.origin, config()), /not allowed/);
    assert.deepEqual(innerHits, []);
    siteHandler = (req, res) => {
      if (req.url === "/robots.txt") return redirect(res, "/robots-v2.txt", 301);
      res.setHeader("content-type", "text/plain");
      res.end("User-agent: *\nDisallow: /private\n");
    };
    assert.match((await defaultLoadRobots(site.origin, config())) ?? "", /Disallow: \/private/);
  });
});

describe("a page cannot exhaust memory", () => {
  it("stops reading an endless response and drops the connection", async () => {
    let closed = false;
    siteHandler = (req, res) => {
      res.setHeader("content-type", "text/html");
      res.write("<html><body>");
      const timer = setInterval(() => res.write("x".repeat(64 * 1024)), 1);
      req.on("close", () => { closed = true; clearInterval(timer); });
    };
    const started = Date.now();
    await assert.rejects(fetchStatic(`${site.origin}/docs/big`, config(), undefined, fetch, null, { ...guard(), maxBytes: 256 * 1024 }), /larger than/);
    assert.ok(Date.now() - started < 2500, "gave up long before the timeout");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(closed, true, "the connection was closed");
  });

  it("refuses a page that announces a huge size without reading it", async () => {
    siteHandler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html", "content-length": String(DEFAULT_MAX_PAGE_BYTES + 1) });
      res.write("<html>");
      setTimeout(() => res.destroy(), 200);
    };
    await assert.rejects(fetchStatic(`${site.origin}/docs/huge`, config(), undefined, fetch, null, guard()), /larger than 5 MB/);
  });

  it("reads a normal multi-byte page exactly", async () => {
    const text = "<html><body>" + "héllo wörld ✓ 日本語 ".repeat(5000) + "</body></html>";
    siteHandler = (_req, res) => html(res, text);
    const page = await fetchStatic(`${site.origin}/docs/ok`, config(), undefined, fetch, null, guard());
    assert.equal(page.html, text);
    const direct = await readBodyCapped(new Response(text), 10_000_000);
    assert.equal(direct, text);
  });
});

describe("private network detection (used to confine rendered pages)", () => {
  it("recognises private, loopback and link-local addresses and not public ones", () => {
    for (const h of ["10.0.0.1", "127.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "[::1]", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) assert.equal(isPrivateHost(h), true, h);
    for (const h of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "192.169.0.1", "dash.gtps.cloud", "2606:4700::1111", "100.63.0.1"]) assert.equal(isPrivateHost(h), false, h);
  });
});
