import type { Db } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { META_LAST_SUCCESS } from "@/server/sync/sync-service";
import { classifyApiEntry, splitApiName, API_KINDS } from "@/server/docs/classify";
import type {
  ApiIndexEntry,
  ApiKind,
  DocApiEntry,
  DocCodeExample,
  DocTree,
  DocsStatus,
  DocTreeNode,
  DocumentDetail,
  DocumentRef,
  ExampleIndexEntry,
  SearchResponse,
  SearchResult,
  SearchScope,
  SnippetSegment,
} from "@/types/docs";
import type { CurrentRun, SyncState } from "@/types/sync";

/**
 * Read side of the documentation explorer. Every function reads the indexed
 * SQLite database; nothing here knows a page, category or API name in advance.
 * Soft-deleted documents (no longer served by the site) are never returned.
 */

const MARK_OPEN = "\u0001";
const MARK_CLOSE = "\u0002";

// ---- hierarchy -------------------------------------------------------------

interface CategoryRow {
  id: number;
  name: string;
  parent_id: number | null;
}
interface DocRow {
  id: number;
  title: string;
  url: string;
  category_id: number | null;
}

const byLabel = (a: DocTreeNode, b: DocTreeNode): number => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true });

function pathSegments(url: string, pathPrefix: string): string[] {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return [];
  }
  const rest = pathname.startsWith(pathPrefix) ? pathname.slice(pathPrefix.length) : pathname;
  return rest.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

const humanize = (segment: string): string => segment.replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());

function countPages(node: DocTreeNode): number {
  node.pageCount = (node.documentId !== null ? 1 : 0) + node.children.reduce((sum, c) => sum + countPages(c), 0);
  return node.pageCount;
}

function sortTree(nodes: DocTreeNode[]): void {
  nodes.sort(byLabel);
  for (const n of nodes) sortTree(n.children);
}

/**
 * The full hierarchy of indexed pages. Pages the site placed in a sidebar group
 * hang under that category (nested through categories.parent_id). Pages without
 * a group are arranged by their URL path under the documentation root.
 */
export function getDocTree(db: Db, pathPrefix = "/docs"): DocTree {
  const categories = db.prepare("SELECT id, name, parent_id FROM categories").all() as unknown as CategoryRow[];
  const docs = db
    .prepare("SELECT id, title, url, category_id FROM documents WHERE deleted_at IS NULL ORDER BY id")
    .all() as unknown as DocRow[];

  const page = (d: DocRow, origin: DocTreeNode["origin"]): DocTreeNode => ({
    id: `doc:${d.id}`, kind: "page", label: d.title, documentId: d.id, url: d.url, pageCount: 0, origin, children: [],
  });

  // Category nodes, nested by parent. Empty categories are dropped at the end.
  const catNodes = new Map<number, DocTreeNode>();
  for (const c of categories) {
    catNodes.set(c.id, {
      id: `cat:${c.id}`, kind: "category", label: c.name, documentId: null, url: null, pageCount: 0,
      origin: "navigation", children: [],
    });
  }
  const roots: DocTreeNode[] = [];
  for (const c of categories) {
    const node = catNodes.get(c.id)!;
    const parent = c.parent_id !== null && c.parent_id !== c.id ? catNodes.get(c.parent_id) : undefined;
    (parent ? parent.children : roots).push(node);
  }

  // Pages in a navigation group.
  const ungrouped: DocRow[] = [];
  for (const d of docs) {
    const cat = d.category_id !== null ? catNodes.get(d.category_id) : undefined;
    if (cat) cat.children.push(page(d, "navigation"));
    else ungrouped.push(d);
  }

  // Everything else: arranged by URL path.
  const withSegments = ungrouped.map((d) => ({ d, segments: pathSegments(d.url, pathPrefix) }));
  const folderPaths = new Set<string>();
  for (const { segments } of withSegments) {
    for (let i = 1; i < segments.length; i++) folderPaths.add(segments.slice(0, i).join("/"));
  }
  const folders = new Map<string, DocTreeNode>();
  const folderFor = (segments: string[]): DocTreeNode => {
    const key = segments.join("/");
    let node = folders.get(key);
    if (!node) {
      node = {
        id: `dir:${key}`, kind: "folder", label: humanize(segments[segments.length - 1] ?? ""), documentId: null,
        url: null, pageCount: 0, origin: "url-path", children: [],
      };
      folders.set(key, node);
      if (segments.length > 1) folderFor(segments.slice(0, -1)).children.push(node);
      else roots.push(node);
    }
    return node;
  };
  for (const { d, segments } of withSegments) {
    const key = segments.join("/");
    if (segments.length > 0 && folderPaths.has(key)) {
      // A page that is also the parent of other pages: the folder itself opens it.
      const folder = folderFor(segments);
      folder.documentId = d.id;
      folder.url = d.url;
      folder.label = d.title;
    } else if (segments.length <= 1) {
      roots.push(page(d, "url-path"));
    } else {
      folderFor(segments.slice(0, -1)).children.push(page(d, "url-path"));
    }
  }

  // Drop categories with no pages, then count and sort.
  const prune = (nodes: DocTreeNode[]): DocTreeNode[] =>
    nodes
      .map((n) => ({ ...n, children: prune(n.children) }))
      .filter((n) => n.kind !== "category" || n.children.length > 0);
  const pruned = prune(roots);
  for (const n of pruned) countPages(n);
  sortTree(pruned);

  const usedCategories = new Set<number>();
  const collect = (nodes: DocTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === "category") usedCategories.add(Number(n.id.slice(4)));
      collect(n.children);
    }
  };
  collect(pruned);

  return { roots: pruned, totalPages: docs.length, categories: usedCategories.size };
}

// ---- documents -------------------------------------------------------------

function categoryPathOf(db: Db, categoryId: number | null): string[] {
  const path: string[] = [];
  const seen = new Set<number>();
  let id = categoryId;
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const row = db.prepare("SELECT name, parent_id FROM categories WHERE id = ?").get(id) as
      | { name: string; parent_id: number | null }
      | undefined;
    if (!row) break;
    path.unshift(row.name);
    id = row.parent_id;
  }
  return path;
}

function toApiEntry(r: Record<string, unknown>): DocApiEntry {
  const name = String(r.name);
  let params: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(r.params_json ?? "[]"));
    if (Array.isArray(parsed)) params = parsed.map(String);
  } catch {
    params = [];
  }
  const kind = (API_KINDS as readonly string[]).includes(String(r.kind)) ? (r.kind as ApiKind) : classifyApiEntry(name);
  return {
    id: Number(r.id),
    name,
    kind,
    owner: splitApiName(name).owner,
    signature: String(r.signature),
    params,
    returns: (r.returns as string | null) ?? null,
    description: (r.description as string | null) ?? null,
  };
}

const toCode = (r: Record<string, unknown>): DocCodeExample => ({
  id: Number(r.id),
  language: (r.language as string | null) ?? null,
  context: (r.context as string | null) ?? null,
  code: String(r.code),
});

export function getDocument(db: Db, where: { id: number } | { url: string }): DocumentDetail | null {
  const row = (
    "id" in where
      ? db.prepare("SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL").get(where.id)
      : db.prepare("SELECT * FROM documents WHERE url = ? AND deleted_at IS NULL").get(where.url)
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  const id = Number(row.id);
  const categoryPath = categoryPathOf(db, (row.category_id as number | null) ?? null);
  return {
    id,
    title: String(row.title),
    url: String(row.url),
    category: categoryPath[categoryPath.length - 1] ?? null,
    categoryPath,
    markdown: String(row.cleaned_content),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastScrapedAt: String(row.last_scraped_at),
    codeExamples: db.prepare("SELECT id, language, context, code FROM code_examples WHERE document_id = ? ORDER BY position").all(id).map((r) => toCode(r as Record<string, unknown>)),
    apiEntries: db.prepare("SELECT * FROM api_entries WHERE document_id = ? ORDER BY id").all(id).map((r) => toApiEntry(r as Record<string, unknown>)),
  };
}

const REF_SELECT = `d.id AS document_id, d.title AS document_title, d.url AS document_url, c.name AS category`;
const REF_FROM = `JOIN documents d ON d.id = x.document_id AND d.deleted_at IS NULL LEFT JOIN categories c ON c.id = d.category_id`;

function refOf(r: Record<string, unknown>): DocumentRef {
  return {
    documentId: Number(r.document_id),
    documentTitle: String(r.document_title),
    documentUrl: String(r.document_url),
    category: (r.category as string | null) ?? null,
  };
}

/** Every indexed API entry (functions, methods, callbacks, events). */
export function listApi(db: Db, kind?: ApiKind): ApiIndexEntry[] {
  const rows = db
    .prepare(
      `SELECT x.*, ${REF_SELECT} FROM api_entries x ${REF_FROM}
        ${kind ? "WHERE x.kind = ?" : ""} ORDER BY x.name COLLATE NOCASE`,
    )
    .all(...(kind ? [kind] : [])) as Record<string, unknown>[];
  return rows.map((r) => ({ ...toApiEntry(r), ...refOf(r) }));
}

/** Every indexed code example; filter by language (e.g. "lua") when given. */
export function listExamples(db: Db, language?: string): ExampleIndexEntry[] {
  const rows = db
    .prepare(
      `SELECT x.id, x.language, x.context, x.code, ${REF_SELECT} FROM code_examples x ${REF_FROM}
        ${language ? "WHERE lower(x.language) = lower(?)" : ""} ORDER BY d.title COLLATE NOCASE, x.position`,
    )
    .all(...(language ? [language] : [])) as Record<string, unknown>[];
  return rows.map((r) => ({ ...toCode(r), ...refOf(r) }));
}

// ---- search ----------------------------------------------------------------

export function parseSnippet(raw: string): SnippetSegment[] {
  const segments: SnippetSegment[] = [];
  let match = false;
  for (const part of raw.split(new RegExp(`([${MARK_OPEN}${MARK_CLOSE}])`))) {
    if (part === MARK_OPEN) match = true;
    else if (part === MARK_CLOSE) match = false;
    else if (part) segments.push({ text: part, match });
  }
  return segments;
}

/** A window of `text` around the first occurrence of any term, with the terms marked. */
export function makeSnippet(text: string, terms: readonly string[], radius = 70): SnippetSegment[] {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  const hits = terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0);
  const first = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, first - radius);
  const end = Math.min(flat.length, first + radius * 2);
  const window = flat.slice(start, end);

  const pattern = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const segments: SnippetSegment[] = [];
  if (start > 0) segments.push({ text: "…", match: false });
  if (pattern.length === 0) segments.push({ text: window, match: false });
  else {
    let last = 0;
    for (const m of window.matchAll(new RegExp(pattern.join("|"), "gi"))) {
      if (m.index > last) segments.push({ text: window.slice(last, m.index), match: false });
      segments.push({ text: m[0], match: true });
      last = m.index + m[0].length;
    }
    if (last < window.length) segments.push({ text: window.slice(last), match: false });
  }
  if (end < flat.length) segments.push({ text: "…", match: false });
  return segments;
}

const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

/** Words for the stemmed index: letters/digits only. The last word matches as a prefix. */
function wordQuery(q: string): string | null {
  const words = q.split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w, i) => (i === words.length - 1 ? `${quote(w)}*` : quote(w))).join(" ");
}

/** Whitespace-separated terms, punctuation kept (for `Player:getName`, `onPlayerChat`). */
const rawTerms = (q: string): string[] => q.split(/\s+/).filter(Boolean);

const wantsKinds = (scope: SearchScope): ApiKind[] | null => (scope === "function" ? ["function", "method"] : null);

function searchDocuments(db: Db, q: string, scope: SearchScope, limit: number): SearchResult[] {
  const words = wordQuery(q);
  if (!words) return [];
  const match = scope === "title" ? `title : (${words})` : words;
  const rows = db
    .prepare(
      `SELECT d.id AS document_id, d.title AS document_title, d.url AS document_url, c.name AS category,
              snippet(search_documents, -1, '${MARK_OPEN}', '${MARK_CLOSE}', '…', 24) AS snip
         FROM search_documents
         JOIN documents d ON d.id = search_documents.rowid AND d.deleted_at IS NULL
         LEFT JOIN categories c ON c.id = d.category_id
        WHERE search_documents MATCH ?
        ORDER BY bm25(search_documents, 10.0, 3.0, 1.0)
        LIMIT ?`,
    )
    .all(match, limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    type: "document", ...refOf(r), label: null, kind: null, snippet: parseSnippet(String(r.snip ?? "")),
  }));
}

/** Trigram tables cannot match terms shorter than 3 characters; those use LIKE. */
function useFts(terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => [...t].length >= 3);
}

function searchApi(db: Db, q: string, scope: SearchScope, limit: number): SearchResult[] {
  const terms = rawTerms(q);
  if (terms.length === 0) return [];
  const kinds = wantsKinds(scope);
  const kindSql = kinds ? `AND x.kind IN (${kinds.map(() => "?").join(",")})` : "";
  const kindArgs = kinds ?? [];

  let rows: Record<string, unknown>[];
  if (useFts(terms)) {
    rows = db
      .prepare(
        `SELECT x.*, ${REF_SELECT}
           FROM search_api s JOIN api_entries x ON x.id = s.rowid ${REF_FROM}
          WHERE search_api MATCH ? ${kindSql}
          ORDER BY bm25(search_api, 10.0, 4.0, 1.0) LIMIT ?`,
      )
      .all(terms.map(quote).join(" AND "), ...kindArgs, limit) as Record<string, unknown>[];
  } else {
    const clause = terms.map(() => "(x.name LIKE ? ESCAPE '\\' OR x.signature LIKE ? ESCAPE '\\' OR x.description LIKE ? ESCAPE '\\')").join(" AND ");
    const args = terms.flatMap((t) => Array<string>(3).fill(`%${likeEscape(t)}%`));
    rows = db
      .prepare(`SELECT x.*, ${REF_SELECT} FROM api_entries x ${REF_FROM} WHERE ${clause} ${kindSql} ORDER BY x.name COLLATE NOCASE LIMIT ?`)
      .all(...args, ...kindArgs, limit) as Record<string, unknown>[];
  }
  return rows.map((r) => {
    const entry = toApiEntry(r);
    const text = [entry.signature, entry.description].filter(Boolean).join(" — ");
    return { type: "api", ...refOf(r), label: entry.name, kind: entry.kind, snippet: makeSnippet(text, terms) };
  });
}

function searchCode(db: Db, q: string, limit: number): SearchResult[] {
  const terms = rawTerms(q);
  if (terms.length === 0) return [];
  let rows: Record<string, unknown>[];
  if (useFts(terms)) {
    rows = db
      .prepare(
        `SELECT x.*, ${REF_SELECT}
           FROM search_code s JOIN code_examples x ON x.id = s.rowid ${REF_FROM}
          WHERE search_code MATCH ? ORDER BY bm25(search_code, 5.0, 1.0) LIMIT ?`,
      )
      .all(terms.map(quote).join(" AND "), limit) as Record<string, unknown>[];
  } else {
    const clause = terms.map(() => "(x.code LIKE ? ESCAPE '\\' OR x.context LIKE ? ESCAPE '\\')").join(" AND ");
    const args = terms.flatMap((t) => Array<string>(2).fill(`%${likeEscape(t)}%`));
    rows = db
      .prepare(`SELECT x.*, ${REF_SELECT} FROM code_examples x ${REF_FROM} WHERE ${clause} ORDER BY d.title COLLATE NOCASE LIMIT ?`)
      .all(...args, limit) as Record<string, unknown>[];
  }
  return rows.map((r) => ({
    type: "code", ...refOf(r), label: (r.language as string | null) ?? null, kind: null,
    snippet: makeSnippet(String(r.code), terms, 60),
  }));
}

/**
 * Full-text search over the indexed documentation (SQLite FTS5).
 * Scopes: all, title, keyword (page text), api (any API name), function
 * (functions and methods only) and code (inside code examples).
 */
export function searchDocs(db: Db, query: string, scope: SearchScope = "all", limit = 30): SearchResponse {
  const q = query.trim();
  const cap = Math.max(1, Math.min(limit, 100));
  let results: SearchResult[] = [];
  if (q) {
    if (scope === "all") results = [...searchDocuments(db, q, scope, cap), ...searchApi(db, q, scope, cap), ...searchCode(db, q, cap)];
    else if (scope === "title" || scope === "keyword") results = searchDocuments(db, q, scope, cap);
    else if (scope === "api" || scope === "function") results = searchApi(db, q, scope, cap);
    else results = searchCode(db, q, cap);
  }
  return {
    query: q,
    scope,
    results,
    counts: {
      document: results.filter((r) => r.type === "document").length,
      api: results.filter((r) => r.type === "api").length,
      code: results.filter((r) => r.type === "code").length,
    },
  };
}

// ---- status ----------------------------------------------------------------

/** Categories that hold at least one active page, plus their ancestors (same as the tree). */
function countUsedCategories(db: Db): number {
  const used = new Set<number>();
  const parents = new Map(
    (db.prepare("SELECT id, parent_id FROM categories").all() as unknown as CategoryRow[]).map((c) => [c.id, c.parent_id]),
  );
  const leaves = db
    .prepare("SELECT DISTINCT category_id AS id FROM documents WHERE deleted_at IS NULL AND category_id IS NOT NULL")
    .all() as unknown as Array<{ id: number }>;
  for (const { id } of leaves) {
    let current: number | null | undefined = id;
    while (current != null && !used.has(current)) {
      used.add(current);
      current = parents.get(current);
    }
  }
  return used.size;
}

const scalar = (db: Db, sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);

/**
 * Index and synchronization status, all read from the database. `live` is the
 * in-memory engine state of this process (the database cannot know whether a
 * run is paused), passed in by the caller.
 */
export function getDocsStatus(
  db: Db,
  live: { state: SyncState; current: CurrentRun | null } = { state: "idle", current: null },
): DocsStatus {
  const repo = new Repository(db);
  const activeDocs = "documents WHERE deleted_at IS NULL";
  const inActive = "document_id IN (SELECT id FROM documents WHERE deleted_at IS NULL)";

  const apiByKind: Record<ApiKind, number> = { function: 0, method: 0, callback: 0, event: 0 };
  const kinds = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM api_entries WHERE ${inActive} GROUP BY kind`)
    .all() as unknown as Array<{ kind: string | null; n: number }>;
  for (const { kind, n } of kinds) {
    if (kind && (API_KINDS as readonly string[]).includes(kind)) apiByKind[kind as ApiKind] = Number(n);
  }

  return {
    totals: {
      documents: scalar(db, `SELECT COUNT(*) AS n FROM ${activeDocs}`),
      codeExamples: scalar(db, `SELECT COUNT(*) AS n FROM code_examples WHERE ${inActive}`),
      luaExamples: scalar(db, `SELECT COUNT(*) AS n FROM code_examples WHERE ${inActive} AND lower(language) = 'lua'`),
      apiEntries: scalar(db, `SELECT COUNT(*) AS n FROM api_entries WHERE ${inActive}`),
      categories: countUsedCategories(db),
      searchIndexed: scalar(
        db,
        "SELECT COUNT(*) AS n FROM search_documents WHERE rowid IN (SELECT id FROM documents WHERE deleted_at IS NULL)",
      ),
    },
    apiByKind,
    lastSuccessAt: repo.getMeta(META_LAST_SUCCESS) || null,
    lastRun: repo.listRuns(5).find((run) => run.status !== "running") ?? null,
    failedPages: repo.listFailed(),
    removedDocuments: scalar(db, "SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NOT NULL"),
    sync: live,
  };
}
