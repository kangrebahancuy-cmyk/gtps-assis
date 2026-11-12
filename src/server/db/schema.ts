/** SQLite schema. Applied idempotently on every database open. */
export const SCHEMA_VERSION = 3;

/**
 * crawl_urls is defined separately because the v1 -> v2 migration has to
 * rebuild it (SQLite cannot alter a CHECK constraint in place).
 */
export const CRAWL_URLS_SQL = `
CREATE TABLE crawl_urls (
  url            TEXT PRIMARY KEY,
  status         TEXT NOT NULL CHECK (status IN ('pending','scraped','failed','duplicate','blocked','deleted')),
  http_status    INTEGER,
  error          TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  discovered_via TEXT,
  discovered_at  TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);`;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL,
  parent_id   INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  title            TEXT NOT NULL,
  url              TEXT NOT NULL UNIQUE,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  parent_url       TEXT,
  raw_content      TEXT NOT NULL,
  cleaned_content  TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_scraped_at  TEXT NOT NULL,
  etag             TEXT,
  last_modified    TEXT,
  deleted_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(content_hash);
CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category_id);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

CREATE TABLE IF NOT EXISTS document_sections (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  level        INTEGER NOT NULL,
  heading      TEXT,
  content      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sections_document ON document_sections(document_id, position);

CREATE TABLE IF NOT EXISTS code_examples (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL,
  language     TEXT,
  context      TEXT,
  code         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_document ON code_examples(document_id);

CREATE TABLE IF NOT EXISTS api_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  signature    TEXT NOT NULL,
  params_json  TEXT NOT NULL,
  description  TEXT,
  returns      TEXT,
  kind         TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_document ON api_entries(document_id);
CREATE INDEX IF NOT EXISTS idx_api_kind ON api_entries(kind);

CREATE TABLE IF NOT EXISTS document_links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  url          TEXT NOT NULL
);

-- One row per URL the crawler has ever discovered, with its latest outcome.
${CRAWL_URLS_SQL.replace("CREATE TABLE", "CREATE TABLE IF NOT EXISTS")}
CREATE INDEX IF NOT EXISTS idx_crawl_status ON crawl_urls(status);

CREATE TABLE IF NOT EXISTS scraping_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT,
  level       TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  url         TEXT,
  message     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_logs_created ON scraping_logs(id DESC);

CREATE TABLE IF NOT EXISTS sync_metadata (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- One row per synchronization run (manual or scheduled).
CREATE TABLE IF NOT EXISTS sync_runs (
  id           TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,
  trigger      TEXT NOT NULL CHECK (trigger IN ('manual','scheduled')),
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  added        INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  unchanged    INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  deleted      INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  blocked      INTEGER NOT NULL DEFAULT 0,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at DESC);

-- Full-text search (FTS5). rowid = id of the source row. See search-index.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS search_documents USING fts5(
  title, category, content, tokenize = 'porter unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_api USING fts5(
  name, signature, description, tokenize = 'trigram'
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_code USING fts5(
  code, context, tokenize = 'trigram'
);
`;
