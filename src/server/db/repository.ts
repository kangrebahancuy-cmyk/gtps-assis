import type { Db } from "@/server/db/database";
import type { ExtractedPage } from "@/server/scraper/extractor";
import type {
  CrawlUrlStatus,
  FailedPage,
  LogLevel,
  ScrapedDocumentSummary,
  ScraperLogEntry,
  ScraperStats,
} from "@/types/scraper";

const now = (): string => new Date().toISOString();

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export type SaveOutcome = "inserted" | "updated" | "unchanged";

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
  saveDocument(page: ExtractedPage, parentUrl: string | null = null): SaveOutcome {
    const ts = now();
    const existing = this.db
      .prepare("SELECT id, content_hash FROM documents WHERE url = ?")
      .get(page.url) as { id: number; content_hash: string } | undefined;

    if (existing && existing.content_hash === page.contentHash) {
      this.db
        .prepare("UPDATE documents SET last_scraped_at = ? WHERE id = ?")
        .run(ts, existing.id);
      return "unchanged";
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
                    cleaned_content = ?, content_hash = ?, updated_at = ?, last_scraped_at = ?
              WHERE id = ?`,
          )
          .run(page.title, categoryId, parentUrl, page.rawContent, page.cleanedContent,
            page.contentHash, ts, ts, documentId);
        for (const table of ["document_sections", "code_examples", "api_entries", "document_links"]) {
          this.db.prepare(`DELETE FROM ${table} WHERE document_id = ?`).run(documentId);
        }
      } else {
        const result = this.db
          .prepare(
            `INSERT INTO documents (title, url, category_id, parent_url, raw_content, cleaned_content,
                                    content_hash, created_at, updated_at, last_scraped_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(page.title, page.url, categoryId, parentUrl, page.rawContent, page.cleanedContent,
            page.contentHash, ts, ts, ts);
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
      return existing ? "updated" : "inserted";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listDocuments(): ScrapedDocumentSummary[] {
    return this.db
      .prepare(
        `SELECT d.id, d.title, d.url, c.name AS category, d.cleaned_content, d.last_scraped_at,
                (SELECT COUNT(*) FROM code_examples e WHERE e.document_id = d.id) AS code_count
           FROM documents d LEFT JOIN categories c ON c.id = d.category_id
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

  getStats(): ScraperStats {
    const byStatus = (s: CrawlUrlStatus) =>
      this.count("SELECT COUNT(*) AS n FROM crawl_urls WHERE status = ?", s);
    return {
      discovered: this.count("SELECT COUNT(*) AS n FROM crawl_urls"),
      scraped: byStatus("scraped"),
      failed: byStatus("failed"),
      pending: byStatus("pending"),
      duplicates: byStatus("duplicate"),
      blocked: byStatus("blocked"),
      documents: this.count("SELECT COUNT(*) AS n FROM documents"),
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

  getLogs(limit = 200): ScraperLogEntry[] {
    return this.db
      .prepare(
        `SELECT id, run_id, level, url, message, created_at
           FROM scraping_logs ORDER BY id DESC LIMIT ?`,
      )
      .all(Math.min(Math.max(limit, 1), 1000) as unknown as string)
      .map((r) => {
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
}
