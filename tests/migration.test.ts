import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";

/** The Step 2 (schema v1) definitions of the tables that changed. */
const V1_SQL = `
CREATE TABLE categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, slug TEXT NOT NULL,
  parent_id INTEGER, created_at TEXT NOT NULL);
CREATE TABLE documents (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, url TEXT NOT NULL UNIQUE,
  category_id INTEGER, parent_url TEXT, raw_content TEXT NOT NULL, cleaned_content TEXT NOT NULL,
  content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_scraped_at TEXT NOT NULL);
CREATE TABLE crawl_urls (url TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending','scraped','failed','duplicate','blocked')),
  http_status INTEGER, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, discovered_via TEXT,
  discovered_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE sync_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`;

describe("database migration from the Step 2 schema", () => {
  it("upgrades in place, keeps all data, and accepts the new 'deleted' status", () => {
    const dir = mkdtempSync(join(tmpdir(), "gtps-migration-"));
    const file = join(dir, "v1.db");
    try {
      const sqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
      const old = new sqlite.DatabaseSync(file);
      old.exec(V1_SQL);
      const ts = "2026-01-01T00:00:00.000Z";
      old.prepare(
        `INSERT INTO documents (title, url, raw_content, cleaned_content, content_hash, created_at, updated_at, last_scraped_at)
         VALUES ('Player', 'https://x.test/docs/player', '<p>raw</p>', 'Player text', 'h1', ?, ?, ?)`,
      ).run(ts, ts, ts);
      old.prepare(
        `INSERT INTO crawl_urls (url, status, error, attempts, discovered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("https://x.test/docs/player", "scraped", null, 1, ts, ts);
      old.prepare(
        `INSERT INTO crawl_urls (url, status, error, attempts, discovered_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("https://x.test/docs/broken", "failed", "HTTP 500", 2, ts, ts);
      old.close();

      const db = openDatabase(file);
      const repo = new Repository(db);

      // Existing data is intact and visible through the new code.
      assert.deepEqual(repo.listDocuments().map((d) => d.title), ["Player"]);
      assert.equal(repo.getStats().failed, 1);
      assert.equal(repo.listFailed()[0]?.error, "HTTP 500");
      assert.equal(repo.getValidators("https://x.test/docs/player")?.etag, null);

      // New columns and the new status work.
      assert.equal(repo.markDeleted("https://x.test/docs/player"), true);
      repo.setUrlStatus("https://x.test/docs/player", "deleted", { httpStatus: 404 });
      assert.equal(repo.getTotals().deleted, 1);
      assert.equal(repo.listDocuments().length, 0);
      db.prepare("SELECT 1 FROM sync_runs").all();
      db.close();

      // Opening again is a no-op (idempotent).
      const again = openDatabase(file);
      assert.equal(new Repository(again).getTotals().deleted, 1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a fresh database is created directly at the new schema", () => {
    const db = openDatabase(":memory:");
    const cols = (db.prepare("PRAGMA table_info(documents)").all() as { name: string }[]).map((c) => c.name);
    for (const c of ["etag", "last_modified", "deleted_at"]) assert.ok(cols.includes(c), c);
    db.prepare("SELECT 1 FROM sync_runs").all();
  });
});
