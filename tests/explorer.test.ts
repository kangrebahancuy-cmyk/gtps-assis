import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { getDocTree, getDocument, listApi, listExamples, searchDocs } from "@/server/docs/explorer";
import type { ExtractedPage } from "@/server/scraper/extractor";
import { sha256 } from "@/server/scraper/hash";
import type { DocTreeNode } from "@/types/docs";

const BASE = "https://docs.example.test/docs";

interface PageSpec {
  slug: string;
  title: string;
  md: string;
  path?: string[];
  api?: Array<[name: string, signature: string, description?: string]>;
  code?: string[];
}

function page(spec: PageSpec): ExtractedPage {
  const url = spec.slug ? `${BASE}/${spec.slug}` : BASE;
  return {
    url,
    title: spec.title,
    category: spec.path?.[spec.path.length - 1] ?? null,
    categoryPath: spec.path ?? [],
    rawContent: `<main>${spec.md}</main>`,
    cleanedContent: spec.md,
    contentHash: sha256(spec.md),
    headings: [],
    sections: [],
    tables: [],
    codeExamples: (spec.code ?? []).map((code) => ({ language: "lua", code, context: spec.title })),
    apiEntries: (spec.api ?? []).map(([name, signature, description]) => ({
      name, signature, params: [], description: description ?? null, returns: null,
    })),
    links: [],
    docLinks: [],
  };
}

const SPECS: PageSpec[] = [
  { slug: "", title: "Overview", md: "# Overview\n\nWelcome to the **Lua scripting** reference." },
  {
    slug: "player", title: "Player", path: ["Lua API", "Objects"],
    md: "# Player\n\nRepresents a connected avatar. Teleport players between worlds.\n\n| Name | Type |\n| --- | --- |\n| id | number |",
    api: [["Player:getName", "Player:getName()", "Returns the name."], ["Player:enterWorld", "Player:enterWorld(worldName)", "Moves this avatar into a world."]],
    code: ["local name = player:getName()\nprint(name)"],
  },
  {
    slug: "world", title: "World", path: ["Lua API", "Objects"],
    md: "# World\n\nA world holds tiles and players.",
    api: [["World:getTile", "World:getTile(x, y)"]],
  },
  {
    slug: "events/chat", title: "Chat events", path: ["Lua API", "Events"],
    md: "# Chat events\n\nFires when somebody talks.",
    api: [["onPlayerChatCallback", "onPlayerChatCallback(function(world, player, message)", "Called for every chat message."]],
    code: ["onPlayerChatCallback(function(world, player, message)\n  return false\nend)"],
  },
  { slug: "guides/start", title: "Getting started", md: "# Getting started\n\nInstall the script and reload.", code: ["reloadScripts()"] },
  { slug: "guides", title: "Guides", md: "# Guides\n\nStep by step tutorials." },
];

function seeded(): { db: ReturnType<typeof openDatabase>; repo: Repository } {
  const db = openDatabase(":memory:");
  const repo = new Repository(db);
  for (const spec of SPECS) repo.saveDocument(page(spec));
  return { db, repo };
}

const flat = (nodes: DocTreeNode[]): DocTreeNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);

describe("getDocTree", () => {
  const { db } = seeded();
  const tree = getDocTree(db, "/docs");

  it("contains every indexed page exactly once", () => {
    const ids = flat(tree.roots).filter((n) => n.documentId !== null).map((n) => n.documentId);
    assert.equal(ids.length, SPECS.length);
    assert.equal(new Set(ids).size, SPECS.length);
    assert.equal(tree.totalPages, SPECS.length);
  });
  it("nests navigation categories and subcategories", () => {
    const luaApi = tree.roots.find((n) => n.label === "Lua API");
    assert.ok(luaApi);
    assert.equal(luaApi.kind, "category");
    assert.deepEqual(luaApi.children.map((c) => c.label), ["Events", "Objects"]);
    const objects = luaApi.children.find((c) => c.label === "Objects");
    assert.deepEqual(objects?.children.map((c) => c.label), ["Player", "World"]);
    assert.equal(luaApi.pageCount, 3);
    assert.equal(tree.categories, 3);
  });
  it("arranges pages without a category by URL path, folders opening their own page", () => {
    const guides = tree.roots.find((n) => n.url === `${BASE}/guides`);
    assert.ok(guides);
    assert.equal(guides.kind, "folder");
    assert.equal(guides.origin, "url-path");
    assert.equal(guides.label, "Guides");
    assert.deepEqual(guides.children.map((c) => c.label), ["Getting started"]);
    assert.equal(guides.pageCount, 2);
  });
  it("lists the documentation root page at the top level", () => {
    assert.ok(tree.roots.some((n) => n.label === "Overview" && n.kind === "page"));
  });
  it("hides soft-deleted documents and prunes empty categories", () => {
    const { db: d, repo } = seeded();
    repo.markDeleted(`${BASE}/events/chat`);
    const t = getDocTree(d, "/docs");
    assert.equal(t.totalPages, SPECS.length - 1);
    assert.ok(!flat(t.roots).some((n) => n.label === "Events"));
  });
});

describe("getDocument / listApi / listExamples", () => {
  const { db } = seeded();
  const player = getDocument(db, { url: `${BASE}/player` });

  it("returns markdown, original URL, category path and sync date", () => {
    assert.ok(player);
    assert.match(player.markdown, /\| Name \| Type \|/);
    assert.equal(player.url, `${BASE}/player`);
    assert.deepEqual(player.categoryPath, ["Lua API", "Objects"]);
    assert.match(player.lastScrapedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(player.codeExamples.length, 1);
    assert.deepEqual(player.apiEntries.map((e) => [e.name, e.kind]), [["Player:getName", "method"], ["Player:enterWorld", "method"]]);
  });
  it("returns null for unknown or deleted documents", () => {
    assert.equal(getDocument(db, { id: 9999 }), null);
    const { db: d, repo } = seeded();
    repo.markDeleted(`${BASE}/world`);
    assert.equal(getDocument(d, { url: `${BASE}/world` }), null);
  });
  it("lists API entries by kind with their pages", () => {
    assert.equal(listApi(db).length, 4);
    assert.deepEqual(listApi(db, "callback").map((e) => e.name), ["onPlayerChatCallback"]);
    assert.equal(listApi(db, "method")[0]?.documentUrl.startsWith(BASE), true);
  });
  it("lists Lua examples with their pages", () => {
    const examples = listExamples(db, "lua");
    assert.equal(examples.length, 3);
    assert.ok(examples.every((e) => e.documentTitle && e.documentUrl));
    assert.equal(listExamples(db, "json").length, 0);
  });
});

describe("searchDocs", () => {
  const { db } = seeded();

  it("finds pages by title", () => {
    const r = searchDocs(db, "player", "title");
    assert.deepEqual(r.results.map((x) => x.documentTitle), ["Player"]);
    assert.equal(r.results[0]?.documentUrl, `${BASE}/player`);
  });
  it("finds pages by keyword in the text, with a marked snippet, category and URL", () => {
    const r = searchDocs(db, "teleport", "keyword");
    assert.equal(r.results.length, 1);
    const hit = r.results[0]!;
    assert.equal(hit.documentTitle, "Player");
    assert.equal(hit.category, "Objects");
    assert.equal(hit.documentUrl, `${BASE}/player`);
    assert.ok(hit.snippet.some((s) => s.match && /teleport/i.test(s.text)));
  });
  it("stems words (porter): 'teleporting' matches 'Teleport'", () => {
    assert.equal(searchDocs(db, "teleporting", "keyword").results.length, 1);
  });
  it("matches a prefix of the last word", () => {
    assert.equal(searchDocs(db, "tutor", "keyword").results[0]?.documentTitle, "Guides");
  });
  it("finds API names by substring, including callbacks", () => {
    assert.deepEqual(searchDocs(db, "chat", "api").results.map((x) => x.label), ["onPlayerChatCallback"]);
    assert.deepEqual(searchDocs(db, "Player:getName", "api").results.map((x) => x.label), ["Player:getName"]);
  });
  it("'function' scope covers functions and methods but not callbacks", () => {
    const names = searchDocs(db, "player", "function").results.map((x) => x.label);
    assert.deepEqual(names.sort(), ["Player:enterWorld", "Player:getName"]);
  });
  it("finds text inside code examples and returns the surrounding code", () => {
    const r = searchDocs(db, "reloadScripts", "code");
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0]?.documentTitle, "Getting started");
    assert.equal(r.results[0]?.label, "lua");
    assert.ok(r.results[0]?.snippet.some((s) => s.match && s.text.toLowerCase() === "reloadscripts"));
  });
  it("short terms (under 3 chars) fall back to substring matching", () => {
    assert.ok(searchDocs(db, "Ti", "api").results.some((x) => x.label === "World:getTile"));
  });
  it("'all' returns document, API and code hits together", () => {
    const r = searchDocs(db, "player", "all");
    assert.ok(r.counts.document >= 1 && r.counts.api >= 1 && r.counts.code >= 1);
    assert.equal(r.results.length, r.counts.document + r.counts.api + r.counts.code);
  });
  it("is safe with FTS syntax characters and empty input", () => {
    for (const q of ['"', "AND OR NOT", "player*", "(", "a:b", "-x", "\\", "NEAR(", "%_"]) {
      for (const scope of ["all", "title", "keyword", "api", "function", "code"] as const) {
        assert.doesNotThrow(() => searchDocs(db, q, scope), `${q} / ${scope}`);
      }
    }
    assert.deepEqual(searchDocs(db, "   ", "all").results, []);
  });
  it("never returns soft-deleted documents, and returns them again once restored", () => {
    const { db: d, repo } = seeded();
    repo.markDeleted(`${BASE}/player`);
    assert.equal(searchDocs(d, "player", "title").results.length, 0);
    assert.equal(searchDocs(d, "getName", "api").results.length, 0);
    assert.equal(searchDocs(d, "getName", "code").results.length, 0);
    repo.saveDocument(page(SPECS[1]!));
    assert.equal(searchDocs(d, "player", "title").results.length, 1);
  });
  it("follows content updates: old text disappears, new text is found", () => {
    const { db: d, repo } = seeded();
    const spec = SPECS[2]!;
    repo.saveDocument(page({ ...spec, md: "# World\n\nNow about zeppelins.", api: [["World:getTile", "World:getTile(x, y)"]], code: ["spawnZeppelin()"] }));
    assert.equal(searchDocs(d, "tiles", "keyword").results.length, 0);
    assert.equal(searchDocs(d, "zeppelins", "keyword").results.length, 1);
    assert.equal(searchDocs(d, "spawnZeppelin", "code").results.length, 1);
    assert.equal(searchDocs(d, "getTile", "api").results.length, 1); // not duplicated
  });
});

describe("getDocsStatus", () => {
  it("reports totals, API kinds, failures and last success from the database", async () => {
    const { getDocsStatus } = await import("@/server/docs/explorer");
    const { db, repo } = seeded();
    repo.discoverUrl(`${BASE}/broken`, null);
    repo.setUrlStatus(`${BASE}/broken`, "failed", { httpStatus: 503, error: "HTTP 503" });
    repo.setMeta("sync.last_success_at", "2026-01-02T03:04:05.000Z");
    repo.markDeleted(`${BASE}/guides`);

    const status = getDocsStatus(db);
    assert.equal(status.totals.documents, SPECS.length - 1);
    assert.equal(status.totals.apiEntries, 4);
    assert.equal(status.totals.codeExamples, 3);
    assert.equal(status.totals.luaExamples, 3);
    assert.equal(status.totals.categories, 3);
    assert.equal(status.totals.searchIndexed, status.totals.documents);
    assert.deepEqual(status.apiByKind, { function: 0, method: 3, callback: 1, event: 0 });
    assert.equal(status.lastSuccessAt, "2026-01-02T03:04:05.000Z");
    assert.deepEqual(status.failedPages.map((f) => [f.url, f.httpStatus]), [[`${BASE}/broken`, 503]]);
    assert.equal(status.removedDocuments, 1);
    assert.equal(status.sync.state, "idle");
    assert.equal(getDocsStatus(openDatabase(":memory:")).totals.documents, 0);
    assert.equal(getDocsStatus(openDatabase(":memory:")).lastSuccessAt, null);
  });
});
