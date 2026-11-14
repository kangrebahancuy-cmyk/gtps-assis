import type { Db } from "@/server/db/database";
import { chunkDocument, identifierWords } from "@/server/rag/chunker";

/**
 * Keeps doc_chunks and the search_chunks FTS5 index in step with the documents
 * table. Called from indexDocument (search-index.ts) every time a page is saved,
 * so a synchronization updates the retrieval index with no extra step.
 * search_chunks rows use the chunk id as rowid.
 */

export function removeChunks(db: Db, documentId: number): void {
  db.prepare("DELETE FROM search_chunks WHERE rowid IN (SELECT id FROM doc_chunks WHERE document_id = ?)").run(documentId);
  db.prepare("DELETE FROM doc_chunks WHERE document_id = ?").run(documentId);
}

export function indexChunks(db: Db, documentId: number): number {
  removeChunks(db, documentId);
  const doc = db.prepare("SELECT title FROM documents WHERE id = ?").get(documentId) as { title: string } | undefined;
  if (!doc) return 0;

  const sections = db
    .prepare("SELECT heading, level, position, content FROM document_sections WHERE document_id = ? ORDER BY position")
    .all(documentId) as Array<{ heading: string | null; level: number; position: number; content: string }>;
  const apiRows = db
    .prepare("SELECT name, signature, params_json, description, returns FROM api_entries WHERE document_id = ? ORDER BY id")
    .all(documentId) as Array<{ name: string; signature: string; params_json: string; description: string | null; returns: string | null }>;
  const codeExamples = db
    .prepare("SELECT language, context, code FROM code_examples WHERE document_id = ? ORDER BY position")
    .all(documentId) as Array<{ language: string | null; context: string | null; code: string }>;

  const chunks = chunkDocument({
    title: doc.title,
    sections,
    apiEntries: apiRows.map((r) => ({
      name: r.name,
      signature: r.signature,
      params: parseParams(r.params_json),
      returns: r.returns,
      description: r.description,
    })),
    codeExamples,
  });

  const insert = db.prepare(
    `INSERT INTO doc_chunks (document_id, position, kind, heading, anchor, label, language, text, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const index = db.prepare("INSERT INTO search_chunks (rowid, heading, text, idents) VALUES (?, ?, ?, ?)");
  for (const c of chunks) {
    const result = insert.run(documentId, c.position, c.kind, c.heading, c.anchor, c.label, c.language, c.text, c.tokens);
    const head = `${doc.title} ${c.heading ?? ""}`;
    index.run(Number(result.lastInsertRowid), head, c.searchText, identifierWords(`${head}\n${c.searchText}`));
  }
  return chunks.length;
}

function parseParams(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Rebuilds the retrieval index of every document (used by migrations and as a repair tool). */
export function rebuildChunkIndex(db: Db): number {
  db.exec("DELETE FROM search_chunks; DELETE FROM doc_chunks;");
  const ids = db.prepare("SELECT id FROM documents").all() as Array<{ id: number }>;
  let total = 0;
  for (const { id } of ids) total += indexChunks(db, id);
  return total;
}
