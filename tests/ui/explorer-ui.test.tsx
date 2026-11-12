/**
 * Server-side render tests for the documentation explorer components, fed with
 * data that really came out of the pipeline (crawl -> SQLite -> explorer
 * service). They render to static markup, so they check structure and content,
 * not clicks, focus or styling. Run with `npm run test:ui`.
 *
 * tsconfig uses jsx:"preserve" (Next compiles JSX), so tsx falls back to the
 * classic runtime; the global React below is what makes that work.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ApiList } from "@/features/docs/api-list";
import { DocTree } from "@/features/docs/doc-tree";
import { DocsSidebar } from "@/features/docs/docs-sidebar";
import { DocsStatusBar } from "@/features/docs/docs-status-bar";
import { DocumentView } from "@/features/docs/docs-viewer";
import { ExamplesList } from "@/features/docs/examples-list";
import { SearchResults } from "@/features/docs/search-results";
import { MarkdownRenderer } from "@/features/chat/markdown-renderer";
import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { getDocTree, getDocsStatus, getDocument, listApi, listExamples, searchDocs } from "@/server/docs/explorer";
import { sha256 } from "@/server/scraper/hash";
import type { ExtractedPage } from "@/server/scraper/extractor";
import type { UseDocsStatus } from "@/hooks/use-docs-status";
import { urlIndex } from "@/lib/doc-tree";

(globalThis as { React?: unknown }).React = React;

const BASE = "https://docs.example.test/docs";

function page(slug: string, title: string, md: string, path: string[], extra: Partial<ExtractedPage> = {}): ExtractedPage {
  return {
    url: `${BASE}/${slug}`, title, category: path[path.length - 1] ?? null, categoryPath: path, rawContent: "", cleanedContent: md,
    contentHash: sha256(md), headings: [], sections: [], tables: [], codeExamples: [], apiEntries: [], links: [], docLinks: [], ...extra,
  };
}

const PLAYER_MD = [
  "# Player", "", `See [World](${BASE}/world) and [Discord](https://discord.gg/x) and \`Player\`.`, "",
  "## Methods", "", "- first", "  - nested", "- second", "", "### Example", "",
  "```lua", 'local name = player:getName()', 'print("Hello " .. name) -- greet', "```", "",
  "## Properties", "", "| Field | Type |", "| --- | ---: |", "| id | number |", "",
].join("\n");

function seeded() {
  const db = openDatabase(":memory:");
  const repo = new Repository(db);
  repo.saveDocument(page("player", "Player", PLAYER_MD, ["Lua API", "Objects"], {
    codeExamples: [{ language: "lua", context: "Example", code: 'local name = player:getName()\nprint("Hello " .. name) -- greet' }],
    apiEntries: [{ name: "Player:getName", signature: "Player:getName()", params: [], description: "Gets the name.", returns: "string" }],
  }));
  repo.saveDocument(page("world", "World", "# World\n\nA world holds tiles.", ["Lua API", "Objects"]));
  repo.saveDocument(page("chat", "Chat events", "# Chat events\n\nFires when somebody talks.", ["Lua API", "Events"], {
    apiEntries: [{ name: "onPlayerChatCallback", signature: "onPlayerChatCallback(function(world, player, message)", params: [], description: null, returns: null }],
    codeExamples: [{ language: "lua", context: null, code: "onPlayerChatCallback(function(world, player, message)\n  return false\nend)" }],
  }));
  return { db, repo };
}

const render = (node: React.ReactElement): string => renderToStaticMarkup(node);
const noop = () => {};

describe("MarkdownRenderer", () => {
  const html = render(<MarkdownRenderer source={PLAYER_MD} />);

  it("renders headings with anchors, nested lists and inline code", () => {
    assert.match(html, /<h1[^>]*id="player"[^>]*>Player<\/h1>/);
    assert.match(html, /<h2[^>]*id="methods"/);
    assert.match(html, /<h3[^>]*id="example"/);
    assert.match(html, /<ul[^>]*>.*?<li>first<ul[^>]*><li>nested<\/li><\/ul><\/li><li>second<\/li><\/ul>/s);
    assert.match(html, /<code[^>]*>Player<\/code>/);
  });
  it("renders tables with header cells and alignment", () => {
    assert.match(html, /<table[^>]*>.*<thead[^>]*>.*<th[^>]*scope="col"[^>]*>Field<\/th>.*<th[^>]*text-right[^>]*>Type<\/th>.*<td[^>]*>id<\/td>.*<td[^>]*text-right[^>]*>number<\/td>/s);
  });
  it("renders Lua code blocks with syntax highlighting and a copy button", () => {
    assert.match(html, /<span[^>]*data-token="keyword"[^>]*>local<\/span>/);
    assert.match(html, /<span[^>]*data-token="string"[^>]*>&quot;Hello &quot;<\/span>/);
    assert.match(html, /<span[^>]*data-token="comment"[^>]*>-- greet<\/span>/);
    assert.match(html, /<span[^>]*data-token="function"[^>]*>getName<\/span>/);
    assert.match(html, /aria-label="Copy code"/);
    assert.match(html, />lua<\/span>/);
  });
  it("does not highlight non-Lua code and escapes HTML in code", () => {
    const out = render(<MarkdownRenderer source={"```json\n{\"a\": \"<b>x</b>\"}\n```"} />);
    assert.doesNotMatch(out, /data-token/);
    assert.match(out, /&lt;b&gt;x&lt;\/b&gt;/);
  });
  it("opens links safely and never turns javascript: URLs into links", () => {
    assert.match(html, /<a[^>]*href="https:\/\/docs\.example\.test\/docs\/world"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
    const bad = render(<MarkdownRenderer source={"[x](javascript:alert(1))"} />);
    assert.doesNotMatch(bad, /<a /);
  });
});

describe("DocTree", () => {
  const { db } = seeded();
  const tree = getDocTree(db, "/docs");

  it("shows categories with page counts and the selected nested page with aria-current", () => {
    const selected = getDocument(db, { url: `${BASE}/chat` })!.id;
    const html = render(<DocTree roots={tree.roots} selectedId={selected} onSelect={noop} />);
    assert.match(html, /Lua API/);
    assert.match(html, />3<\/span>/); // Lua API holds 3 pages
    assert.match(html, /Objects/);
    assert.match(html, /<button[^>]*aria-current="page"[^>]*>.*Chat events/s);
    assert.match(html, /aria-expanded="true"[^>]*aria-label="Collapse Events"/);
  });
  it("collapses groups that do not contain the selected page", () => {
    const player = getDocument(db, { url: `${BASE}/player` })!.id;
    const html = render(<DocTree roots={tree.roots} selectedId={player} onSelect={noop} />);
    assert.match(html, /aria-label="Expand Events"/);
    assert.doesNotMatch(html, /Chat events/);
    assert.match(html, />Player</);
  });
  it("explains an empty index instead of showing placeholder pages", () => {
    assert.match(render(<DocTree roots={[]} selectedId={null} onSelect={noop} />), /No documents are indexed yet/);
  });
});

describe("ApiList and ExamplesList", () => {
  const { db } = seeded();
  it("groups API entries by owner, shows kinds and counts", () => {
    const html = render(<ApiList entries={listApi(db)} onSelect={noop} />);
    assert.match(html, /All <span[^>]*>2<\/span>/);
    assert.match(html, /Methods <span[^>]*>1<\/span>/);
    assert.match(html, /Callbacks <span[^>]*>1<\/span>/);
    assert.doesNotMatch(html, /Events <span/); // no entries of that kind: no chip
    assert.match(html, /Player:getName\(\)/);
    assert.match(html, /onPlayerChatCallback\(function\(world, player, message\)/);
    assert.match(html, /Callbacks &amp; events/);
  });
  it("says so when there are no API entries", () => {
    assert.match(render(<ApiList entries={[]} onSelect={noop} />), /No API entries were found/);
  });
  it("lists Lua examples with highlighting and the page they come from", () => {
    const html = render(<ExamplesList examples={listExamples(db, "lua")} onSelect={noop} />);
    assert.match(html, /Player/);
    assert.match(html, /Chat events/);
    assert.match(html, /data-token="keyword"/);
    assert.match(render(<ExamplesList examples={[]} onSelect={noop} />), /No Lua examples were found/);
  });
});

describe("SearchResults", () => {
  const { db } = seeded();
  it("shows title, matching text with highlight, category and the original URL", () => {
    const html = render(<SearchResults response={searchDocs(db, "tiles", "keyword")} loading={false} error={null} onSelect={noop} />);
    assert.match(html, /1 result: 1 page, 0 API, 0 code/);
    assert.match(html, />World<\/span>/);
    assert.match(html, /<mark[^>]*>tiles<\/mark>/);
    assert.match(html, /Objects/);
    assert.match(html, /<a[^>]*href="https:\/\/docs\.example\.test\/docs\/world"[^>]*target="_blank"/);
  });
  it("labels API and code hits", () => {
    const api = render(<SearchResults response={searchDocs(db, "chat", "api")} loading={false} error={null} onSelect={noop} />);
    assert.match(api, />onPlayerChatCallback<\/span>/);
    assert.match(api, />callback<\/span>/);
    assert.match(api, /in Chat events/);
    const code = render(<SearchResults response={searchDocs(db, "return false", "code")} loading={false} error={null} onSelect={noop} />);
    assert.match(code, />lua code<\/span>/);
  });
  it("handles no results, searching and errors", () => {
    assert.match(render(<SearchResults response={searchDocs(db, "zzzz", "all")} loading={false} error={null} onSelect={noop} />), /No results for/);
    assert.match(render(<SearchResults response={null} loading error={null} onSelect={noop} />), /Searching/);
    assert.match(render(<SearchResults response={null} loading={false} error="boom" onSelect={noop} />), /role="alert"[^>]*>boom/);
  });
});

describe("DocumentView", () => {
  const { db } = seeded();
  const doc = getDocument(db, { url: `${BASE}/player` })!;
  const html = render(<DocumentView document={doc} urlToId={urlIndex(getDocTree(db, "/docs").roots)} onNavigate={noop} />);

  it("shows the category path, the original page link and the last synchronization date", () => {
    assert.match(html, /Lua API.*Objects/s);
    assert.match(html, /<a[^>]*href="https:\/\/docs\.example\.test\/docs\/player"[^>]*>.*Open original page/s);
    assert.match(html, /Last synchronized: <time dateTime="\d{4}-[^"]+">/);
  });
  it("renders the stored Markdown: heading, table, Lua code and an outline", () => {
    assert.match(html, /<h1[^>]*>Player<\/h1>/);
    assert.match(html, /<table/);
    assert.match(html, /data-token="keyword"/);
    assert.match(html, /aria-label="On this page"/);
    assert.match(html, /href="#methods"/);
    assert.match(html, /1 code example/);
  });
  it("omits the outline for short pages", () => {
    const world = getDocument(db, { url: `${BASE}/world` })!;
    assert.doesNotMatch(render(<DocumentView document={world} urlToId={new Map()} onNavigate={noop} />), /On this page/);
  });
});

describe("DocsStatusBar", () => {
  const { db, repo } = seeded();
  repo.discoverUrl(`${BASE}/broken`, null);
  repo.setUrlStatus(`${BASE}/broken`, "failed", { httpStatus: 503, error: "HTTP 503" });
  repo.setMeta("sync.last_success_at", "2026-02-03T04:05:06.000Z");
  const data = (patch: Partial<UseDocsStatus> = {}): UseDocsStatus => ({ status: getDocsStatus(db), error: null, unreachable: false, ...patch });

  it("shows real totals, last successful sync, failed pages and the sync state", () => {
    const html = render(<DocsStatusBar data={data()} syncOpen={false} onToggleSync={noop} />);
    assert.match(html, /Indexed documents<\/dt><dd[^>]*>3</);
    assert.match(html, /API entries<\/dt><dd[^>]*>2</);
    assert.match(html, /Lua examples<\/dt><dd[^>]*>2</);
    assert.match(html, /Failed pages<\/dt><dd[^>]*text-red-500[^>]*>1</);
    assert.match(html, new RegExp(new Date("2026-02-03T04:05:06.000Z").toLocaleString().replace(/[/.]/g, "\\$&")));
    assert.match(html, /https:\/\/docs\.example\.test\/docs\/broken<\/span><span[^>]*> — HTTP 503/);
    assert.match(html, />idle<\/span>/);
  });
  it("reports 'Never' before any successful sync and warns about an incomplete search index", () => {
    const empty = openDatabase(":memory:");
    assert.match(render(<DocsStatusBar data={{ status: getDocsStatus(empty), error: null, unreachable: false }} syncOpen={false} onToggleSync={noop} />), /Last successful sync<\/dt><dd[^>]*>Never</);
    const status = getDocsStatus(db);
    status.totals.searchIndexed = 1;
    assert.match(render(<DocsStatusBar data={data({ status })} syncOpen={false} onToggleSync={noop} />), /Search index is incomplete: 1 of 3/);
  });
  it("shows live progress while running, and says when the backend is unreachable", () => {
    const status = getDocsStatus(db);
    status.sync = {
      state: "running",
      current: { runId: "r", mode: "full", trigger: "manual", startedAt: "x", counts: { added: 0, updated: 0, unchanged: 0, failed: 0, deleted: 0, duplicates: 0, blocked: 0 }, progress: { processed: 2, total: 5, percent: 40, currentUrl: null } },
    };
    assert.match(render(<DocsStatusBar data={data({ status })} syncOpen onToggleSync={noop} />), />running<\/span>.*2\/5/s);
    assert.match(render(<DocsStatusBar data={data({ unreachable: true })} syncOpen={false} onToggleSync={noop} />), /Cannot reach the local backend/);
    assert.match(render(<DocsStatusBar data={{ status: null, error: null, unreachable: false }} syncOpen={false} onToggleSync={noop} />), /Loading status/);
  });
});

describe("DocsSidebar", () => {
  it("offers every search scope and the three navigation tabs while not searching", () => {
    const html = render(<DocsSidebar query="" onQueryChange={noop} scope="all" onScopeChange={noop} tab="api" onTabChange={noop}>x</DocsSidebar>);
    for (const label of ["Everything", "Title", "Keyword \\(page text\\)", "API name", "Function", "Inside code examples"]) assert.match(html, new RegExp(`>${label}<`));
    assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>Pages/);
    assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>API/);
    assert.match(html, />Lua examples</);
  });
  it("hides the tabs while a search is active", () => {
    const html = render(<DocsSidebar query="chat" onQueryChange={noop} scope="all" onScopeChange={noop} tab="pages" onTabChange={noop}>x</DocsSidebar>);
    assert.doesNotMatch(html, /role="tab"/);
  });
});
