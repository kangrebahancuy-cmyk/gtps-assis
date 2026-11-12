import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { listApi, searchDocs } from "@/server/docs/explorer";

/** Schema v2 (Step 3) definitions of the tables Step 4 touches: no `kind`, no FTS tables. */
const V2_SQL = `
CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL,
  parent_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
  category_id INTEGER, parent_url TEXT, raw_content TEXT NOT NULL, cleaned_content TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_scraped_at TEXT NOT NULL,
  etag TEXT, last_modified TEXT, deleted_at TEXT);
CREATE TABLE api_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, name TEXT NOT NULL,
  signature TEXT NOT NULL, params_json TEXT NOT NULL, description TEXT, returns TEXT);
CREATE TABLE code_examples (id INTEGER PRIMARY KEY AUTOINCREMENT, document_id INTEGER NOT NULL, position INTEGER NOT NULL,
  language TEXT, context TEXT, code TEXT NOT NULL);
`;

describe("database migration from the Step 3 schema (v2 -> v3)", () => {
  it("backfills API kinds and builds the search indexes for existing documents, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtps-search-migration-"));
    const file = join(dir, "v2.db");
    try {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const old = new sqlite.DatabaseSync(file);
      old.exec(V2_SQL);
      const ts = "2026-01-01T00:00:00.000Z";
      const insertDoc = old.prepare(
        `INSERT INTO documents (title, url, raw_content, cleaned_content, content_hash, created_at, updated_at, last_scraped_at, deleted_at)
         VALUES (?, ?, '<p>raw</p>', ?, ?, ?, ?, ?, ?)`,
      );
      insertDoc.run("Chat events", "https://x.test/docs/chat", "# Chat events\n\nFires when somebody talks.", "h1", ts, ts, ts, null);
      insertDoc.run("Gone", "https://x.test/docs/gone", "Removed page about zeppelins", "h2", ts, ts, ts, ts);
      old.prepare(
        `INSERT INTO api_entries (document_id, name, signature, params_json, description) VALUES (1, ?, ?, '[]', ?)`,
      ).run("onPlayerChatCallback", "onPlayerChatCallback(function(world, player, message)", "Called for every chat message.");
      old.prepare(`INSERT INTO api_entries (document_id, name, signature, params_json) VALUES (1, 'Player:getName', 'Player:getName()', '[]')`).run();
      old.prepare(`INSERT INTO code_examples (document_id, position, language, context, code) VALUES (1, 0, 'lua', 'Chat events', ?)`).run(
        "onPlayerChatCallback(function(world, player, message)\n  return false\nend)",
      );
      old.close();

      let db = openDatabase(file);
      assert.deepEqual(listApi(db).map((e) => [e.name, e.kind]), [["onPlayerChatCallback", "callback"], ["Player:getName", "method"]]);
      assert.equal(searchDocs(db, "talks", "keyword").results[0]?.documentTitle, "Chat events");
      assert.equal(searchDocs(db, "chat", "api").results.length, 1);
      assert.equal(searchDocs(db, "return false", "code").results.length, 1);
      assert.equal(searchDocs(db, "zeppelins", "keyword").results.length, 0, "soft-deleted pages stay out of search");
      db.close();

      // Opening again must not duplicate index rows.
      db = openDatabase(file);
      const rows = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
      assert.equal(rows("SELECT COUNT(*) AS n FROM search_api"), 2);
      assert.equal(rows("SELECT COUNT(*) AS n FROM search_code"), 1);
      assert.equal(searchDocs(db, "talks", "keyword").results.length, 1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
