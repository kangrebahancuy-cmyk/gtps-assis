import type { Db } from "@/server/db/database";
import { markdownToPlainText } from "@/lib/markdown-plain";
import { classifyApiEntry } from "@/server/docs/classify";

/**
 * Maintains the three FTS5 indexes. Rows are keyed by the rowid of their source
 * row, so a search hit maps straight back to documents / api_entries / code_examples.
 *
 *  - search_documents: porter-stemmed full text (title, category, content)
 *  - search_api:       trigram, so "chat" finds onPlayerChatCallback
 *  - search_code:      trigram over code examples
 */

/** Removes the index rows of a document's API entries and code examples. */
export function removeChildIndex(db: Db, documentId: number): void {
  db.prepare("DELETE FROM search_api WHERE rowid IN (SELECT id FROM api_entries WHERE document_id = ?)").run(documentId);
  db.prepare("DELETE FROM search_code WHERE rowid IN (SELECT id FROM code_examples WHERE document_id = ?)").run(documentId);
}

/** (Re)indexes one document and its children from the current table contents. */
export function indexDocument(db: Db, documentId: number): void {
  db.prepare("DELETE FROM search_documents WHERE rowid = ?").run(documentId);
  const doc = db
    .prepare(
      `SELECT d.title, COALESCE(c.name, '') AS category, d.cleaned_content AS content
         FROM documents d LEFT JOIN categories c ON c.id = d.category_id WHERE d.id = ?`,
    )
    .get(documentId) as { title: string; category: string; content: string } | undefined;
  if (doc) {
    // Plain text, so snippets show words rather than Markdown syntax. Code has its own index.
    db.prepare("INSERT INTO search_documents (rowid, title, category, content) VALUES (?, ?, ?, ?)").run(
      documentId, doc.title, doc.category, markdownToPlainText(doc.content),
    );
  }

  removeChildIndex(db, documentId);
  db.prepare(
    `INSERT INTO search_api (rowid, name, signature, description)
     SELECT id, name, signature, COALESCE(description, '') FROM api_entries WHERE document_id = ?`,
  ).run(documentId);
  db.prepare(
    `INSERT INTO search_code (rowid, code, context)
     SELECT id, code, COALESCE(context, '') FROM code_examples WHERE document_id = ?`,
  ).run(documentId);
}

/** Rebuilds every index from scratch. Used by migrations and as a repair tool. */
export function rebuildSearchIndex(db: Db): number {
  db.exec("DELETE FROM search_documents; DELETE FROM search_api; DELETE FROM search_code;");
  const ids = db.prepare("SELECT id FROM documents").all() as { id: number }[];
  for (const { id } of ids) indexDocument(db, id);
  return ids.length;
}

/** Fills api_entries.kind for rows created before the column existed. */
export function backfillApiKinds(db: Db): void {
  const rows = db.prepare("SELECT id, name FROM api_entries WHERE kind IS NULL").all() as {
    id: number;
    name: string;
  }[];
  const update = db.prepare("UPDATE api_entries SET kind = ? WHERE id = ?");
  for (const row of rows) update.run(classifyApiEntry(row.name), row.id);
}
