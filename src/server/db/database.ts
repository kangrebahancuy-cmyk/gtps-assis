import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { getDatabasePath } from "@/server/scraper/config";
import { CRAWL_URLS_SQL, SCHEMA_SQL, SCHEMA_VERSION } from "@/server/db/schema";
import { backfillApiKinds, rebuildSearchIndex } from "@/server/db/search-index";

export type Db = DatabaseSync;

/**
 * Loaded at runtime via process.getBuiltinModule so bundlers never try to
 * resolve "node:sqlite" (a prefix-only builtin that older externals lists miss).
 */
function loadSqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule?.("node:sqlite");
  if (!mod) {
    throw new Error("node:sqlite is unavailable. Use Node.js 22.13 or newer.");
  }
  return mod as typeof import("node:sqlite");
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column,
  );
}

/**
 * Upgrades a Step 2 (schema v1) database in place, keeping all data:
 * adds the change-detection columns and rebuilds crawl_urls so it accepts the
 * new 'deleted' status. A fresh database has no documents table yet and skips this.
 */
export function migrateFromV1(db: Db): void {
  const hasDocuments = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'documents'")
    .get();
  if (!hasDocuments || hasColumn(db, "documents", "deleted_at")) return;

  db.exec("BEGIN");
  try {
    for (const column of ["etag TEXT", "last_modified TEXT", "deleted_at TEXT"]) {
      db.exec(`ALTER TABLE documents ADD COLUMN ${column}`);
    }
    db.exec("ALTER TABLE crawl_urls RENAME TO crawl_urls_v1");
    db.exec(CRAWL_URLS_SQL);
    db.exec("INSERT INTO crawl_urls SELECT * FROM crawl_urls_v1");
    db.exec("DROP TABLE crawl_urls_v1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** v2 -> v3: api_entries gains a `kind` column. */
function addApiKindColumn(db: Db): void {
  const exists = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'api_entries'")
    .get();
  if (exists && !hasColumn(db, "api_entries", "kind")) {
    db.exec("ALTER TABLE api_entries ADD COLUMN kind TEXT");
  }
}

/**
 * A database created before full-text search existed has documents but empty
 * indexes: classify the old API entries and build the indexes once.
 */
function populateSearchIndexIfNeeded(db: Db): void {
  const documents = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  const indexed = (db.prepare("SELECT COUNT(*) AS n FROM search_documents").get() as { n: number }).n;
  db.exec("BEGIN");
  try {
    backfillApiKinds(db);
    if (documents > 0 && indexed === 0) rebuildSearchIndex(db);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Opens (and migrates) a SQLite database. Pass ":memory:" for tests.
 * Uses Node's built-in `node:sqlite`, so no native addon is required.
 */
export function openDatabase(path: string = getDatabasePath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  migrateFromV1(db);
  addApiKindColumn(db);
  db.exec(SCHEMA_SQL);
  populateSearchIndexIfNeeded(db);
  db.prepare(
    `INSERT INTO sync_metadata (key, value, updated_at) VALUES ('schema_version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(String(SCHEMA_VERSION), new Date().toISOString());
  return db;
}

let shared: Db | null = null;

/** Process-wide connection used by the API routes. */
export function getDatabase(): Db {
  shared ??= openDatabase();
  return shared;
}
