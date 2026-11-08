import type { Db } from "@/server/db/database";
import type { ExtractedPage } from "@/server/scraper/extractor";
import type {
  CrawlUrlStatus,
  FailedPage,
  LogLevel,
  ScrapedDocumentSummary,
  ScraperLogEntry,
} from "@/types/scraper";
import type {
  ChangeCounts,
  SyncMode,
  SyncRunRecord,
  SyncRunStatus,
  SyncTotals,
  SyncTrigger,
} from "@/types/sync";

const now = (): string => new Date().toISOString();

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export type SaveOutcome = "inserted" | "updated" | "unchanged" | "restored";

/** HTTP cache validators remembered per document for conditional requests. */
export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

export interface UrlStats {
  discovered: number;
  scraped: number;
  failed: number;
  pending: number;
  duplicates: number;
  blocked: number;
  deleted: number;
  /** Documents in the index, excluding ones marked deleted. */
  documents: number;
}

interface CountRow {
  n: number;
}

export class Repository {
  constructor(private readonly db: Db) {}

  // ---- crawl queue --------------------------------------------------------

  /** Registers a URL. Returns true if it was new, false if already known. */
  discoverUrl(url: string, via: string | null): boolean {
    const ts = now();
    const result = this.db
      .prepare(
        `INSERT INTO crawl_urls (url, status, discovered_via, discovered_at, updated_at)
         VALUES (?, 'pending', ?, ?, ?) ON CONFLICT(url) DO NOTHING`,
      )
      .run(url, via, ts, ts);
    return Number(result.changes) > 0;
  }

  /**
   * Called for every link found on a page. Returns true when the URL should be
   * added to the queue now: it is new, or it was marked deleted but is linked
   * again (so a restored page gets noticed).
   */
  queueLink(url: string, via: string | null): boolean {
    if (this.discoverUrl(url, via)) return true;
    const row = this.db.prepare("SELECT status FROM crawl_urls WHERE url = ?").get(url) as
      | { status: string }
      | undefined;
    if (row?.status !== "deleted") return false;
    this.db
      .prepare("UPDATE crawl_urls SET status = 'pending', updated_at = ? WHERE url = ?")
      .run(now(), url);
    return true;
  }

  /** Re-queues URLs for a run. Deleted URLs return only via queueLink or a full run. */
  requeueForSync(mode: SyncMode): number {
    if (mode === "retry") return this.requeueFailed();
    const where = mode === "full" ? "" : "WHERE status <> 'deleted'";
    const result = this.db
      .prepare(
        `UPDATE crawl_urls SET status = 'pending', error = NULL, http_status = NULL, updated_at = ? ${where}`,
      )
      .run(now());
    return Number(result.changes);
  }

  setUrlStatus(
    url: string,
    status: CrawlUrlStatus,
    details: { httpStatus?: number | null; error?: string | null; incrementAttempts?: boolean } = {},
  ): void {
    this.db
      .prepare(
        `UPDATE crawl_urls
            SET status = ?, http_status = ?, error = ?,
                attempts = attempts + ?, updated_at = ?
          WHERE url = ?`,
      )
      .run(
        status,
        details.httpStatus ?? null,
        details.error ?? null,
        details.incrementAttempts ? 1 : 0,
        now(),
        url,
      );
  }

  listUrlsByStatus(status: CrawlUrlStatus): string[] {
    return this.db
      .prepare("SELECT url FROM crawl_urls WHERE status = ? ORDER BY discovered_at, url")
      .all(status)
      .map((row) => String((row as { url: string }).url));
  }

  /** Puts failed URLs back in the queue so a retry run picks them up. */
  requeueFailed(): number {
    const result = this.db
      .prepare(
        `UPDATE crawl_urls SET status = 'pending', error = NULL, http_status = NULL, updated_at = ?
          WHERE status = 'failed'`,
      )
      .run(now());
    return Number(result.changes);
  }

  /** Puts every known URL back in the queue for a full re-crawl. */
  requeueAll(): number {
    const result = this.db
      .prepare(
        `UPDATE crawl_urls SET status = 'pending', error = NULL, http_status = NULL, updated_at = ?`,
      )
      .run(now());
    return Number(result.changes);
  }

  listFailed(): FailedPage[] {
    return this.db
      .prepare(
        `SELECT url, error, http_status, attempts FROM crawl_urls
          WHERE status = 'failed' ORDER BY url`,
      )
      .all()
      .map((r) => {
        const row = r as { url: string; error: string | null; http_status: number | null; attempts: number };
        return {
          url: row.url,
          error: row.error,
          httpStatus: row.http_status,
          attempts: row.attempts,
        };
      });
  }

  // ---- documents ----------------------------------------------------------

  findDocumentByHash(hash: string): { id: number; url: string } | null {
    const row = this.db
      .prepare("SELECT id, url FROM documents WHERE content_hash = ? LIMIT 1")
      .get(hash) as { id: number; url: string } | undefined;
    return row ?? null;
  }

  private categoryId(name: string | null): number | null {
    if (!name) return null;
    this.db
      .prepare(
        `INSERT INTO categories (name, slug, created_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO NOTHING`,
      )
      .run(name, slugify(name), now());
    const row = this.db.prepare("SELECT id FROM categories WHERE name = ?").get(name) as
      | { id: number }
      | undefined;
    return row?.id ?? null;
  }

  /**
   * Inserts or updates a document and replaces its child rows atomically.
   * `unchanged` means the content hash matched, so only last_scraped_at moved.
   */
  saveDocument(
    page: ExtractedPage,
    parentUrl: string | null = null,
    validators: Validators = { etag: null, lastModified: null },
  ): SaveOutcome {
    const ts = now();
    const existing = this.db
      .prepare("SELECT id, content_hash, deleted_at FROM documents WHERE url = ?")
      .get(page.url) as { id: number; content_hash: string; deleted_at: string | null } | undefined;

    if (existing && existing.content_hash === page.contentHash) {
      // Same content: only record that it was checked. No child rows are rewritten.
      this.db
        .prepare(
          `UPDATE documents SET last_scraped_at = ?, etag = ?, last_modified = ?, deleted_at = NULL
            WHERE id = ?`,
        )
        .run(ts, validators.etag, validators.lastModified, existing.id);
      return existing.deleted_at ? "restored" : "unchanged";
    }

    this.db.exec("BEGIN");
    try {
      const categoryId = this.categoryId(page.category);
      let documentId: number;

      if (existing) {
        documentId = existing.id;
        this.db
          .prepare(
            `UPDATE documents SET title = ?, category_id = ?, parent_url = ?, raw_content = ?,
                    cleaned_content = ?, content_hash = ?, updated_at = ?, last_scraped_at = ?,
                    etag = ?, last_modified = ?, deleted_at = NULL
              WHERE id = ?`,
          )
          .run(page.title, categoryId, parentUrl, page.rawContent, page.cleanedContent,
            page.contentHash, ts, ts, validators.etag, validators.lastModified, documentId);
        for (const table of ["document_sections", "code_examples", "api_entries", "document_links"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(documentId);
        }
      } else {
        const result = this.db
          .prepare(
            `INSERT INTO documents (title, url, category_id, parent_url, raw_content, cleaned_content,
                                    content_hash, created_at, updated_at, last_scraped_at, etag, last_modified)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(page.title, page.url, categoryId, parentUrl, page.rawContent, page.cleanedContent,
            page.contentHash, ts, ts, ts, validators.etag, validators.lastModified);
        documentId = Number(result.lastInsertRowid);
      }

      const section = this.db.prepare(
        `INSERT INTO document_sections (document_id, position, level, heading, content)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const s of page.sections) {
        section.run(documentId, s.position, s.level, s.heading, s.content);
      }

      const code = this.db.prepare(
        `INSERT INTO code_examples (document_id, position, language, context, code)
         VALUES (?, ?, ?, ?, ?)`,
      );
      page.codeExamples.forEach((c, index) => {
        code.run(documentId, index, c.language, c.context, c.code);
      });

      const api = this.db.prepare(
        `INSERT INTO api_entries (document_id, name, signature, params_json, description, returns)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const e of page.apiEntries) {
        api.run(documentId, e.name, e.signature, JSON.stringify(e.params), e.description, e.returns);
      }

      const link = this.db.prepare(
        "INSERT INTO document_links (document_id, text, url) VALUES (?, ?, ?)",
      );
      for (const l of page.links) link.run(documentId, l.text, l.url);

      this.db.exec("COMMIT");
      if (existing) return existing.deleted_at ? "restored" : "updated";
      return "inserted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Cache validators saved for a document, or null when it is not indexed. */
  getValidators(url: string): Validators | null {
    const row = this.db
      .prepare("SELECT etag, last_modified FROM documents WHERE url = ? AND deleted_at IS NULL")
      .get(url) as { etag: string | null; last_modified: string | null } | undefined;
    return row ? { etag: row.etag, lastModified: row.last_modified } : null;
  }

  hasActiveDocument(url: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS x FROM documents WHERE url = ? AND deleted_at IS NULL").get(url),
    );
  }

  isMarkedDeleted(url: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS x FROM documents WHERE url = ? AND deleted_at IS NOT NULL").get(url),
    );
  }

  /** The source says the page is gone. The document is kept (soft delete). */
  markDeleted(url: string): boolean {
    const result = this.db
      .prepare("UPDATE documents SET deleted_at = ? WHERE url = ? AND deleted_at IS NULL")
      .run(now(), url);
    return Number(result.changes) > 0;
  }

  /** Records a successful "not modified" check without touching content. */
  touchDocument(url: string): void {
    this.db
      .prepare("UPDATE documents SET last_scraped_at = ? WHERE url = ? AND deleted_at IS NULL")
      .run(now(), url);
  }

  listDocuments(): ScrapedDocumentSummary[] {
    return this.db
      .prepare(
        `SELECT d.id, d.title, d.url, c.name AS category, d.cleaned_content, d.last_scraped_at,
                (SELECT COUNT(*) FROM code_examples e WHERE e.document_id = d.id) AS code_count
           FROM documents d LEFT JOIN categories c ON c.id = d.category_id
          WHERE d.deleted_at IS NULL
          ORDER BY d.title COLLATE NOCASE`,
      )
      .all()
      .map((r) => {
        const row = r as {
          id: number; title: string; url: string; category: string | null;
          cleaned_content: string; last_scraped_at: string; code_count: number;
        };
        return {
          id: row.id,
          title: row.title,
          url: row.url,
          category: row.category,
          cleanedContent: row.cleaned_content,
          codeExampleCount: row.code_count,
          lastScrapedAt: row.last_scraped_at,
        };
      });
  }

  // ---- stats / metadata ---------------------------------------------------

  private count(sql: string, ...args: string[]): number {
    return Number((this.db.prepare(sql).get(...args) as CountRow | undefined)?.n ?? 0);
  }

  getStats(): UrlStats {
    const byStatus = (s: CrawlUrlStatus) =>
      this.count("SELECT COUNT(*) AS n FROM crawl_urls WHERE status = ?", s);
    return {
      discovered: this.count("SELECT COUNT(*) AS n FROM crawl_urls"),
      scraped: byStatus("scraped"),
      failed: byStatus("failed"),
      pending: byStatus("pending"),
      duplicates: byStatus("duplicate"),
      blocked: byStatus("blocked"),
      deleted: this.count("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL"),
      documents: this.count("SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL"),
    };
  }

  getTotals(): SyncTotals {
    const stats = this.getStats();
    return {
      documents: stats.documents,
      deleted: stats.deleted,
      failedOutstanding: stats.failed,
      discoveredUrls: stats.discovered,
    };
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_metadata (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, now());
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM sync_metadata WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  // ---- logs ---------------------------------------------------------------

  log(level: LogLevel, message: string, url: string | null = null, runId: string | null = null): void {
    this.db
      .prepare(
        "INSERT INTO scraping_logs (run_id, level, url, message, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(runId, level, url, message, now());
  }

  getLogs(limit = 200, runId: string | null = null): ScraperLogEntry[] {
    const capped = Math.min(Math.max(Math.trunc(limit) || 1, 1), 1000);
    const rows = runId
      ? this.db
          .prepare(
            `SELECT id, run_id, level, url, message, created_at
               FROM scraping_logs WHERE run_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(runId, capped)
      : this.db
          .prepare(
            `SELECT id, run_id, level, url, message, created_at
               FROM scraping_logs ORDER BY id DESC LIMIT ?`,
          )
          .all(capped);
    return rows.map((r) => {
      const row = r as {
        id: number; run_id: string | null; level: LogLevel;
        url: string | null; message: string; created_at: string;
      };
      return {
        id: row.id,
        runId: row.run_id,
        level: row.level,
        url: row.url,
        message: row.message,
        createdAt: row.created_at,
      };
    });
  }

  // ---- sync runs ----------------------------------------------------------

  createRun(id: string, mode: SyncMode, trigger: SyncTrigger, startedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_runs (id, mode, trigger, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
      )
      .run(id, mode, trigger, startedAt);
  }

  finishRun(id: string, status: SyncRunStatus, counts: ChangeCounts, error: string | null): void {
    this.db
      .prepare(
        `UPDATE sync_runs SET status = ?, finished_at = ?, added = ?, updated = ?, unchanged = ?,
                failed = ?, deleted = ?, duplicates = ?, blocked = ?, error = ?
          WHERE id = ?`,
      )
      .run(status, now(), counts.added, counts.updated, counts.unchanged, counts.failed,
        counts.deleted, counts.duplicates, counts.blocked, error, id);
  }

  /** Marks runs left "running" by a process that died. Returns how many were fixed. */
  recoverInterruptedRuns(): number {
    const result = this.db
      .prepare(
        `UPDATE sync_runs SET status = 'interrupted', finished_at = ?,
                error = 'The backend stopped while this run was in progress.'
          WHERE status = 'running'`,
      )
      .run(now());
    const count = Number(result.changes);
    if (count > 0) this.log("warn", `${count} sync run(s) were interrupted by a backend stop`);
    return count;
  }

  private toRun(r: unknown): SyncRunRecord {
    const row = r as {
      id: string; mode: SyncMode; trigger: SyncTrigger; status: SyncRunStatus;
      started_at: string; finished_at: string | null; added: number; updated: number;
      unchanged: number; failed: number; deleted: number; duplicates: number;
      blocked: number; error: string | null;
    };
    return {
      id: row.id,
      mode: row.mode,
      trigger: row.trigger,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      counts: {
        added: row.added, updated: row.updated, unchanged: row.unchanged, failed: row.failed,
        deleted: row.deleted, duplicates: row.duplicates, blocked: row.blocked,
      },
      error: row.error,
    };
  }

  listRuns(limit = 20): SyncRunRecord[] {
    return this.db
      .prepare("SELECT * FROM sync_runs ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(Math.min(Math.max(Math.trunc(limit) || 1, 1), 200))
      .map((r) => this.toRun(r));
  }

  getLastRun(): SyncRunRecord | null {
    return this.listRuns(1)[0] ?? null;
  }
}
