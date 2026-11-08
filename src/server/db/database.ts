import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { getDatabasePath } from "@/server/scraper/config";
import { SCHEMA_SQL, SCHEMA_VERSION } from "@/server/db/schema";

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

/**
 * Opens (and migrates) a SQLite database. Pass ":memory:" for tests.
 * Uses Node's built-in `node:sqlite`, so no native addon is required.
 */
export function openDatabase(path: string = getDatabasePath()): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new (loadSqlite().DatabaseSync)(path);
  db.exec("PRAGMA foreign_keys = ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA_SQL);
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
