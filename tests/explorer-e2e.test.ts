/**
 * Whole pipeline for Step 4 over real HTTP: local server with HTML pages and a
 * sidebar -> real crawler/fetch/robots/conditional requests -> real extractor
 * (pure-DOM, run through the test-only parser instead of Cheerio) -> SQLite
 * -> explorer service. The HTML is hand-written, NOT captured from
 * dash.gtps.cloud.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { getDocTree, getDocument, getDocsStatus, listApi, listExamples, searchDocs } from "@/server/docs/explorer";
import { createConfig } from "@/server/scraper/config";
import { extractFromDom } from "@/server/scraper/extract-dom";
import { fetchStatic, withRetries, type PageFetcher } from "@/server/scraper/fetcher";
import { SyncService } from "@/server/sync/sync-service";
import { parseMarkdown } from "@/lib/markdown";
import type { DocTreeNode } from "@/types/docs";
import { parseHtml, serializeHtml } from "./mini-html";

const SIDEBAR = `<aside>
  <a href="/docs">Overview</a>
  <details open><summary>Lua API</summary><ul>
    <li><a href="/docs/player">Player</a></li><li><a href="/docs/world">World</a></li></ul></details>
  <details><summary>Events</summary><ul><li><a href="/docs/events/chat">Chat events</a></li></ul></details>
</aside>`;

const layout = (main: string) =>
  `<!doctype html><html><head><title>GTPS Cloud</title></head><body><header><a href="/docs">Docs</a></header>${SIDEBAR}<main>${main}</main></body></html>`;

const PAGES: Record<string, string> = {
  "/docs": layout(`<h1>Overview</h1><p>Welcome to the <strong>GTPS Cloud</strong> Lua reference.</p>`),
  "/docs/player": layout(`<h1>Player</h1><p>Represents a connected avatar. Teleport players between worlds.</p>
    <h2>Methods</h2>
    <div class="entry"><p>Player:getName()</p><p>Gets the avatar name.</p><p>Returns string</p><pre><code>Player:getName()</code></pre></div>
    <div class="entry"><p>Player:enterWorld(worldName)</p><p>Moves this avatar into a world.</p><p>Returns void</p><pre><code>Player:enterWorld(worldName)</code></pre></div>
    <h3>Example</h3><pre class="language-lua"><code>local name = player:getName()
print("Hello " .. name) -- greet</code></pre>
    <table><thead><tr><th>Field</th><th>Type</th></tr></thead><tbody><tr><td>id</td><td>number</td></tr></tbody></table>
    <p>See <a href="/docs/world">World</a>.</p>`),
  "/docs/world": layout(`<h1>World</h1><p>A world holds tiles.</p>
    <div class="entry"><p>World:getTile(x, y)</p><p>Gets a tile.</p><pre><code>World:getTile(x, y)</code></pre></div>`),
  "/docs/events/chat": layout(`<h1>Chat events</h1><p>Fires when somebody talks.</p>
    <div class="entry"><p>onPlayerChatCallback(function(world, player, message)</p><p>Called for every chat message.</p>
    <pre><code>onPlayerChatCallback(function(world, player, message)
  return false
end)</code></pre></div>`),
};

async function rig() {
  const overrides: Record<string, number> = {};
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    if (path === "/robots.txt") { res.writeHead(404); return res.end(); }
    const status = overrides[path];
    if (status) { res.writeHead(status, { "content-type": "text/html" }); return res.end("error"); }
    const html = PAGES[path];
    if (!html) { res.writeHead(404, { "content-type": "text/html" }); return res.end("nf"); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config = createConfig({ startUrl: `${origin}/docs`, requestDelayMs: 0, maxRetries: 0, timeoutMs: 2000, minContentLength: 5 });
  const fetcher: PageFetcher = {
    fetchPage: (url, signal, validators) =>
      withRetries(() => fetchStatic(url, config, signal, fetch, validators ?? null), { maxRetries: 0, backoffMs: 1, signal, sleep: async () => {} }),
    close: async () => {},
  };
  const db = openDatabase(":memory:");
  const repo = new Repository(db);
  const service = new SyncService({
    repo, config, createFetcher: () => fetcher, sleep: async () => {},
    extract: (html, url, cfg) => extractFromDom(parseHtml(html), url, cfg, serializeHtml),
  });
  const sync = async (mode: "full" | "incremental" | "auto" = "auto") => {
    assert.ok(service.start(mode).ok);
    await service.whenIdle();
    return service.getStatus();
  };
  return { origin, db, repo, config, sync, overrides, hits, close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) };
}

const flat = (nodes: DocTreeNode[]): DocTreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

describe("documentation explorer over a real crawl", () => {
  it("indexes every page and exposes the whole hierarchy from the database", async () => {
    const t = await rig();
    try {
      const status = await t.sync();
      assert.equal(status.lastRun?.counts.added, 4);
      const tree = getDocTree(t.db, t.config.pathPrefix);
      assert.equal(tree.totalPages, 4);
      const luaApi = tree.roots.find((n) => n.label === "Lua API");
      assert.deepEqual(luaApi?.children.map((c) => c.label), ["Player", "World"]);
      assert.deepEqual(tree.roots.find((n) => n.label === "Events")?.children.map((c) => c.label), ["Chat events"]);
      assert.ok(tree.roots.some((n) => n.kind === "page" && n.label === "Overview"));
    } finally { await t.close(); }
  });

  it("every indexed page opens, and its original link answers HTTP 200", async () => {
    const t = await rig();
    try {
      await t.sync();
      const ids = flat(getDocTree(t.db, t.config.pathPrefix).roots).flatMap((n) => (n.documentId === null ? [] : [n.documentId]));
      assert.equal(ids.length, 4);
      for (const id of ids) {
        const doc = getDocument(t.db, { id });
        assert.ok(doc, `document ${id} is accessible`);
        assert.ok(doc.markdown.length > 0);
        assert.match(doc.lastScrapedAt, /^\d{4}-/);
        const response = await fetch(doc.url);
        assert.equal(response.status, 200, doc.url);
        assert.match(await response.text(), new RegExp(doc.title));
      }
    } finally { await t.close(); }
  });

  it("stores Markdown whose tables and Lua code blocks parse back into structured blocks", async () => {
    const t = await rig();
    try {
      await t.sync();
      const player = getDocument(t.db, { url: `${t.origin}/docs/player` });
      assert.ok(player);
      assert.deepEqual(player.categoryPath, ["Lua API"]);
      const blocks = parseMarkdown(player.markdown);
      const table = blocks.find((b) => b.type === "table");
      assert.deepEqual(table?.type === "table" && [table.header, table.rows], [["Field", "Type"], [["id", "number"]]]);
      const lua = blocks.filter((b) => b.type === "code" && b.language === "lua");
      assert.ok(lua.some((b) => b.type === "code" && b.code.includes('print("Hello " .. name) -- greet')));
      assert.ok(blocks.some((b) => b.type === "heading" && b.level === 2 && b.text === "Methods"));
      assert.match(player.markdown, new RegExp(`\\[World\\]\\(${t.origin}/docs/world\\)`));
    } finally { await t.close(); }
  });

  it("searches by title, API name, function, keyword and inside code", async () => {
    const t = await rig();
    try {
      await t.sync();
      assert.deepEqual(searchDocs(t.db, "world", "title").results.map((r) => r.documentTitle), ["World"]);
      assert.deepEqual(searchDocs(t.db, "chat", "api").results.map((r) => r.label), ["onPlayerChatCallback"]);
      assert.deepEqual(searchDocs(t.db, "enterWorld", "function").results.map((r) => r.label), ["Player:enterWorld"]);
      const keyword = searchDocs(t.db, "teleport", "keyword").results;
      assert.equal(keyword[0]?.documentTitle, "Player");
      assert.equal(keyword[0]?.category, "Lua API");
      assert.equal(keyword[0]?.documentUrl, `${t.origin}/docs/player`);
      assert.ok(keyword[0]?.snippet.some((s) => s.match));
      assert.equal(searchDocs(t.db, "greet", "code").results[0]?.documentTitle, "Player");
      assert.equal(searchDocs(t.db, "return false", "code").results[0]?.documentTitle, "Chat events");
      assert.equal(searchDocs(t.db, "zzzznotthere", "all").results.length, 0);
      assert.equal(listApi(t.db).length, 4);
      assert.equal(listExamples(t.db, "lua").length, 5);
    } finally { await t.close(); }
  });

  it("status reflects a page that stops working: failed pages and removed pages come from the database", async () => {
    const t = await rig();
    try {
      await t.sync();
      t.overrides["/docs/player"] = 503; // temporary outage: the indexed copy must stay
      t.overrides["/docs/world"] = 404; // removed at the source
      const status = await t.sync("full");
      assert.equal(status.lastRun?.status, "completed_with_errors");

      const docs = getDocsStatus(t.db, { state: status.state, current: status.current });
      assert.deepEqual(docs.failedPages.map((f) => [f.url.replace(t.origin, ""), f.httpStatus]), [["/docs/player", 503]]);
      assert.equal(docs.totals.documents, 3);
      assert.equal(docs.removedDocuments, 1);
      assert.equal(docs.totals.searchIndexed, 3);
      assert.ok(getDocument(t.db, { url: `${t.origin}/docs/player` }), "outage does not remove the indexed page");
      assert.equal(getDocument(t.db, { url: `${t.origin}/docs/world` }), null, "a 404 hides the page");
      assert.equal(searchDocs(t.db, "tiles", "keyword").results.length, 0);
      assert.equal(docs.sync.state, "idle");
    } finally { await t.close(); }
  });
});
