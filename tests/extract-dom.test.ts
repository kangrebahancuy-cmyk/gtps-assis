/**
 * Pure-DOM extraction tests. They run without Cheerio by using the test-only
 * parser in ./mini-html. Fixtures are hand-written to match the structure
 * observed on https://dash.gtps.cloud/docs; they are NOT captured live HTML.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractFromDom, type ExtractedPage } from "@/server/scraper/extract-dom";
import { testConfig } from "./helpers";
import { parseHtml, serializeHtml } from "./mini-html";

const cfg = testConfig({ startUrl: "https://dash.gtps.cloud/docs" });
const URL_ = "https://dash.gtps.cloud/docs/player";

const extract = (html: string, url = URL_): ExtractedPage => extractFromDom(parseHtml(html), url, cfg, serializeHtml);

export const PAGE = `<!doctype html><html><head><title>GTPS Cloud | Dashboard</title></head><body>
<header><a href="/docs">Lua API Docs</a></header>
<nav><a href="/docs">Overview</a><a href="/docs/world">World</a><a href="/docs/shop-item">ShopItem</a>
  <a href="https://discord.gg/x">Discord</a><a href="#top">top</a></nav>
<main>
  <h1>Player</h1>
  <p>Methods for <strong>player</strong> objects. See <a href="/docs/world">World</a> and <code>Player</code>.</p>
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

describe("extractFromDom: structure", () => {
  const page = extract(PAGE);

  it("uses the h1 as title and preserves the heading hierarchy", () => {
    assert.equal(page.title, "Player");
    assert.deepEqual(page.headings.map((h) => [h.level, h.text]), [[1, "Player"], [2, "Methods"], [3, "Example"]]);
    assert.deepEqual(page.sections.map((s) => s.position), page.sections.map((_, i) => i));
  });
  it("keeps the original URL and a stable 64-char content hash", () => {
    assert.equal(page.url, URL_);
    assert.equal(page.contentHash, extract(PAGE).contentHash);
    assert.match(page.contentHash, /^[0-9a-f]{64}$/);
  });
  it("extracts function names, parameters, descriptions and return types", () => {
    const enter = page.apiEntries.find((e) => e.name === "Player:enterWorld");
    assert.deepEqual(enter?.params, ["worldName", "notification", "bypass"]);
    assert.equal(enter?.returns, "void");
    assert.equal(enter?.description, "Moves this avatar into a world.");
    assert.equal(page.apiEntries.find((e) => e.name === "Player:getName")?.returns, "string");
    assert.equal(page.apiEntries.find((e) => e.name === "onPlayerChatCallback")?.params.join(","), "world,player,message");
  });
  it("extracts tables as headers and rows", () => {
    assert.deepEqual(page.tables[0], { headers: ["Name", "Type"], rows: [["id", "number"], ["name", "string"]] });
  });
  it("discovers internal doc links from navigation and ignores external/anchor links", () => {
    assert.deepEqual([...page.docLinks].sort(), [
      "https://dash.gtps.cloud/docs",
      "https://dash.gtps.cloud/docs/shop-item",
      "https://dash.gtps.cloud/docs/world",
    ]);
  });
  it("lists body links with their text and not navigation links", () => {
    assert.deepEqual(page.links.map((l) => l.text), ["World", "World reference"]);
  });
  it("serialises the main content as the raw content", () => {
    assert.match(page.rawContent, /^<main>/);
    assert.doesNotMatch(page.rawContent, /Discord/);
  });
});

describe("extractFromDom: Markdown body", () => {
  const md = extract(PAGE).cleanedContent;

  it("renders headings, inline formatting and absolute links", () => {
    assert.match(md, /^# Player\n\nMethods for \*\*player\*\* objects\. See \[World\]\(https:\/\/dash\.gtps\.cloud\/docs\/world\) and `Player`\./);
    assert.match(md, /\n## Methods\n/);
    assert.match(md, /\n### Example\n/);
  });
  it("renders lists", () => {
    assert.match(md, /- worldName\n- notification/);
  });
  it("renders code blocks as fenced Lua", () => {
    assert.match(md, /```lua\nonPlayerChatCallback\(function\(world, player, message\)\n  -- code here\nend\)\n```/);
  });
  it("renders tables as GFM", () => {
    assert.match(md, /\| Name \| Type \|\n\| --- \| --- \|\n\| id \| number \|\n\| name \| string \|/);
  });
  it("drops navigation and scripts", () => {
    assert.doesNotMatch(md, /Overview|Discord|Lua API Docs/);
    const withScript = extract(`<body><main><h1>A</h1><script>var secret = 1;</script><style>.x{}</style><p>kept</p></main></body>`);
    assert.equal(withScript.cleanedContent, "# A\n\nkept");
  });
});

describe("extractFromDom: code examples", () => {
  const page = extract(PAGE);
  it("finds every <pre>, tagged or detected as Lua, with its heading as context", () => {
    assert.equal(page.codeExamples.length, 3);
    assert.ok(page.codeExamples.every((c) => c.language === "lua"));
    assert.match(page.codeExamples[2]?.code ?? "", /onPlayerChatCallback[\s\S]*end\)/);
    assert.equal(page.codeExamples[2]?.context, "Example");
    assert.equal(page.codeExamples[0]?.context, "Methods");
  });
  it("keeps declared non-Lua languages and uses a longer fence when the code has backticks", () => {
    const p = extract(`<main><h1>T</h1><pre class="language-json"><code>{"a": "\`\`\`"}</code></pre></main>`);
    assert.equal(p.codeExamples[0]?.language, "json");
    assert.match(p.cleanedContent, /````json\n\{"a": "```"\}\n````/);
  });
  it("preserves indentation and blank lines inside code", () => {
    const p = extract(`<main><h1>T</h1><pre><code>local a = 1\n\n  if a then\n    print(a)\n  end</code></pre></main>`);
    assert.equal(p.codeExamples[0]?.code, "local a = 1\n\n  if a then\n    print(a)\n  end");
  });
});

describe("extractFromDom: tables and lists edge cases", () => {
  it("promotes the first row to header when the table has none, and escapes pipes", () => {
    const p = extract(`<main><h1>T</h1><table><tr><td>a|b</td><td>c</td></tr><tr><td>1</td><td>2</td></tr></table></main>`);
    assert.match(p.cleanedContent, /\| a\\\|b \| c \|\n\| --- \| --- \|\n\| 1 \| 2 \|/);
    assert.deepEqual(p.tables[0], { headers: [], rows: [["a|b", "c"], ["1", "2"]] });
  });
  it("renders ordered and nested lists", () => {
    const p = extract(`<main><h1>T</h1><ol><li>one<ul><li>inner</li></ul></li><li>two</li></ol></main>`);
    assert.match(p.cleanedContent, /1\. one\n {2}- inner\n2\. two/);
  });
  it("turns bare text in containers into paragraphs", () => {
    const p = extract(`<main><h1>T</h1><div>loose <b>text</b> here<div>nested block</div></div></main>`);
    assert.match(p.cleanedContent, /loose \*\*text\*\* here\n\nnested block/);
  });
  it("keeps a heading that sits inside a <header>, and returns an empty body for a blank page", () => {
    assert.equal(extract(`<main><header><h1>Title</h1></header><p>x</p></main>`).title, "Title");
    assert.equal(extract("<html><body></body></html>").cleanedContent, "");
  });
});

describe("extractFromDom: navigation categories", () => {
  const side = (inner: string) =>
    `<body><aside>${inner}</aside><main><h1>Player</h1><p>x</p></main></body>`;

  it("reads <details><summary> groups", () => {
    const p = extract(side(`<details><summary>Core API</summary><a href="/docs/world">World</a><a href="/docs/player">Player</a></details>`));
    assert.deepEqual(p.categoryPath, ["Core API"]);
    assert.equal(p.category, "Core API");
  });
  it("reads nested <li> groups as category and subcategory", () => {
    const p = extract(
      side(`<ul><li><span>Lua API</span><ul><li><span>Objects</span><ul><li><a href="/docs/world">World</a></li><li><a href="/docs/player">Player</a></li></ul></li></ul></li></ul>`),
    );
    assert.deepEqual(p.categoryPath, ["Lua API", "Objects"]);
    assert.equal(p.category, "Objects");
  });
  it("reads heading/label siblings and ignores generic labels", () => {
    const p = extract(
      side(`<h2>Documentation</h2><div><h3>Events</h3><ul><li><a href="/docs/player">Player</a></li></ul></div><div><h3>Other</h3><ul><li><a href="/docs/world">World</a></li></ul></div>`),
    );
    assert.deepEqual(p.categoryPath, ["Events"]);
    const generic = extract(side(`<h2>Documentation</h2><ul><li><a href="/docs/player">Player</a></li></ul>`));
    assert.deepEqual(generic.categoryPath, []);
    assert.equal(generic.category, null);
  });
  it("uses the group that contains this page's own link, not a neighbour's", () => {
    const html = side(
      `<details><summary>A</summary><a href="/docs/world">World</a></details><details><summary>B</summary><a href="/docs/player">Player</a></details>`,
    );
    assert.equal(extract(html).category, "B");
    assert.equal(extract(html, "https://dash.gtps.cloud/docs/world").category, "A");
  });
  it("falls back to breadcrumbs, skipping generic items and the page itself", () => {
    const p = extract(
      `<body><nav aria-label="Breadcrumb"><ol><li><a href="/docs">Docs</a></li><li><a href="/docs/api">API Reference</a></li><li>Player</li></ol></nav><main><h1>Player</h1><p>x</p></main></body>`,
    );
    assert.deepEqual(p.categoryPath, ["API Reference"]);
  });
  it("reports no category when the page exposes none", () => {
    assert.deepEqual(extract(PAGE).categoryPath, []);
    assert.equal(extract(PAGE).category, null);
  });
});
