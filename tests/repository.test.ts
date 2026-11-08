import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { BASE, fakeExtract, body, freshRepo, testConfig } from "./helpers";

const cfg = testConfig();
const page = (title: string, text: string, code: string[] = []) =>
  fakeExtract(body({ title, text, code }), `${BASE}/docs/${title.toLowerCase()}`, cfg);

describe("database schema", () => {
  it("creates every required table", () => {
    const db = openDatabase(":memory:");
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map((t) => t.name);
    for (const t of ["documents", "categories", "document_sections", "code_examples",
      "scraping_logs", "sync_metadata", "crawl_urls", "api_entries", "document_links"]) {
      assert.ok(tables.includes(t), `missing table ${t}`);
    }
  });
  it("documents store every required field", () => {
    const db = openDatabase(":memory:");
    const cols = (db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["id", "title", "url", "category_id", "raw_content", "cleaned_content",
      "content_hash", "created_at", "updated_at", "last_scraped_at"]) {
      assert.ok(cols.includes(c), `missing column ${c}`);
    }
  });
});

describe("Repository.saveDocument", () => {
  it("inserts a document with its sections and code examples", () => {
    const { repo } = freshRepo();
    const p = page("Player", "Player methods", ["Player:getName()", "print(1)"]);
    assert.equal(repo.saveDocument(p), "inserted");
    const [doc] = repo.listDocuments();
    assert.equal(doc?.title, "Player");
    assert.equal(doc?.url, p.url);
    assert.equal(doc?.codeExampleCount, 2);
  });
  it("reports unchanged content and only bumps last_scraped_at", () => {
    const { repo } = freshRepo();
    const p = page("Player", "Player methods");
    repo.saveDocument(p);
    assert.equal(repo.saveDocument(p), "unchanged");
    assert.equal(repo.listDocuments().length, 1);
  });
  it("updates changed content and replaces child rows", () => {
    const { repo } = freshRepo();
    repo.saveDocument(page("Player", "old text", ["a()"]));
    assert.equal(repo.saveDocument(page("Player", "new text", ["b()", "c()"])), "updated");
    const [doc] = repo.listDocuments();
    assert.equal(doc?.cleanedContent, "new text");
    assert.equal(doc?.codeExampleCount, 2);
  });
  it("detects duplicate content by hash", () => {
    const { repo } = freshRepo();
    const a = page("Alpha", "identical body");
    repo.saveDocument(a);
    const b = page("Beta", "identical body");
    assert.equal(repo.findDocumentByHash(b.contentHash)?.url, a.url);
    assert.equal(repo.findDocumentByHash("nope"), null);
  });
  it("rolls back the whole document if a child insert fails", () => {
    const { repo } = freshRepo();
    const p = page("Player", "text", ["x()"]);
    // A lone surrogate-free but invalid value: force a failure with a bad section.
    (p.sections[0] as { content: unknown }).content = { not: "a string" };
    assert.throws(() => repo.saveDocument(p));
    assert.equal(repo.listDocuments().length, 0);
  });
});

describe("crawl queue and stats", () => {
  it("de-duplicates discovered URLs", () => {
    const { repo } = freshRepo();
    assert.equal(repo.discoverUrl(`${BASE}/docs`, null), true);
    assert.equal(repo.discoverUrl(`${BASE}/docs`, null), false);
    assert.equal(repo.getStats().discovered, 1);
  });
  it("tracks statuses and requeues failed pages", () => {
    const { repo } = freshRepo();
    for (const u of ["a", "b", "c"]) repo.discoverUrl(`${BASE}/docs/${u}`, null);
    repo.setUrlStatus(`${BASE}/docs/a`, "scraped");
    repo.setUrlStatus(`${BASE}/docs/b`, "failed", { httpStatus: 500, error: "HTTP 500" });
    const stats = repo.getStats();
    assert.deepEqual([stats.scraped, stats.failed, stats.pending], [1, 1, 1]);
    assert.equal(repo.listFailed()[0]?.error, "HTTP 500");
    assert.equal(repo.requeueFailed(), 1);
    assert.equal(repo.getStats().failed, 0);
  });
  it("stores and returns logs newest first, and sync metadata", () => {
    const { repo } = freshRepo();
    repo.log("info", "first");
    repo.log("error", "second", `${BASE}/docs/x`, "run-1");
    const logs = repo.getLogs();
    assert.equal(logs[0]?.message, "second");
    assert.equal(logs[0]?.runId, "run-1");
    repo.setMeta("k", "v1");
    repo.setMeta("k", "v2");
    assert.equal(repo.getMeta("k"), "v2");
  });
});
