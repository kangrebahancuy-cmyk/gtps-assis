/**
 * HTML extraction tests. They need Cheerio, so they run after `npm install`.
 *
 * The fixtures are hand-written to match the page structure observed on
 * https://dash.gtps.cloud/docs (single h1/h2, plain-text signatures, a
 * "Parameters"/"Returns" pair, and a <pre> per entry). They are NOT captured
 * copies of the live HTML. Run `npm run scrape` to verify against the real site.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractPage, looksClientRendered } from "@/server/scraper/extractor";
import { testConfig } from "./helpers";

const cfg = testConfig({ startUrl: "https://dash.gtps.cloud/docs" });
const URL_ = "https://dash.gtps.cloud/docs/player";

const PAGE = `<!doctype html><html><head><title>GTPS Cloud | Dashboard</title></head><body>
<header><a href="/docs">Lua API Docs</a></header>
<nav><a href="/docs">Overview</a><a href="/docs/world">World</a><a href="/docs/shop-item">ShopItem</a>
  <a href="https://discord.gg/x">Discord</a><a href="#top">top</a></nav>
<main>
  <h1>Player</h1>
  <p>Methods for <strong>player</strong> objects.</p>
  <h2>Methods</h2>
  <div class="entry">
    <p>Player:getName()</p><p>Returns the name for this avatar.</p><p>Returns string</p>
    <pre><code>Player:getName()</code></pre>
  </div>
  <div class="entry">
    <p>Player:enterWorld(worldName, notification, bypass)</p>
    <p>Moves this avatar into a world.</p><p>Parameters</p><ul><li>worldName</li><li>notification</li></ul><p>Returns void</p>
    <pre class="language-lua"><code>Player:enterWorld(worldName, notification, bypass)</code></pre>
  </div>
  <h3>Example</h3>
  <pre><code>onPlayerChatCallback(function(world, player, message)
  -- code here
end)</code></pre>
  <table><thead><tr><th>Name</th><th>Type</th></tr></thead>
    <tbody><tr><td>id</td><td>number</td></tr><tr><td>name</td><td>string</td></tr></tbody></table>
  <p><a href="/docs/world">World reference</a></p>
</main></body></html>`;

describe("extractPage", () => {
  const page = extractPage(PAGE, URL_, cfg);

  it("uses the h1 as title and preserves the heading hierarchy", () => {
    assert.equal(page.title, "Player");
    assert.deepEqual(page.headings.map((h) => [h.level, h.text]), [[1, "Player"], [2, "Methods"], [3, "Example"]]);
    assert.deepEqual(page.sections.map((s) => s.position), page.sections.map((_, i) => i));
  });
  it("keeps the original URL and a stable content hash", () => {
    assert.equal(page.url, URL_);
    assert.equal(page.contentHash, extractPage(PAGE, URL_, cfg).contentHash);
    assert.match(page.contentHash, /^[0-9a-f]{64}$/);
  });
  it("extracts paragraphs and strips scripts/nav from cleaned content", () => {
    assert.match(page.cleanedContent, /Methods for player objects\./);
    assert.doesNotMatch(page.cleanedContent, /Overview/);
  });
  it("extracts Lua code examples, tagged or detected", () => {
    assert.equal(page.codeExamples.length, 3);
    assert.ok(page.codeExamples.every((c) => c.language === "lua"));
    assert.match(page.codeExamples[2]?.code ?? "", /onPlayerChatCallback[\s\S]*end\)/);
    assert.equal(page.codeExamples[2]?.context, "Example");
  });
  it("extracts function names, parameters, descriptions and return types", () => {
    const enter = page.apiEntries.find((e) => e.name === "Player:enterWorld");
    assert.deepEqual(enter?.params, ["worldName", "notification", "bypass"]);
    assert.equal(enter?.returns, "void");
    assert.equal(enter?.description, "Moves this avatar into a world.");
    assert.equal(page.apiEntries.find((e) => e.name === "Player:getName")?.returns, "string");
  });
  it("extracts tables", () => {
    assert.deepEqual(page.tables[0], { headers: ["Name", "Type"], rows: [["id", "number"], ["name", "string"]] });
  });
  it("discovers internal doc links from navigation and ignores external/anchor links", () => {
    assert.deepEqual([...page.docLinks].sort(), [
      "https://dash.gtps.cloud/docs",
      "https://dash.gtps.cloud/docs/shop-item",
      "https://dash.gtps.cloud/docs/world",
    ]);
  });
  it("lists body links with their text", () => {
    assert.deepEqual(page.links, [{ text: "World reference", url: "https://dash.gtps.cloud/docs/world" }]);
  });
});

describe("empty and client-rendered pages", () => {
  it("returns empty cleaned content for a blank page so the crawler can fail it", () => {
    assert.equal(extractPage("<html><body></body></html>", URL_, cfg).cleanedContent, "");
  });
  it("detects an empty client-rendered shell", () => {
    assert.equal(looksClientRendered('<html><body><div id="root"></div><script src="/app.js"></script></body></html>'), true);
    assert.equal(looksClientRendered(PAGE), false);
  });
});
