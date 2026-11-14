import type { Db } from "@/server/db/database";
import { identifierWords, estimateTokens } from "@/server/rag/chunker";
import { detectIntent, splitWords, type Intent } from "@/server/rag/intent";
import { cleanField, neutralizeUntrusted } from "@/server/rag/sanitize";
import { META_LAST_SUCCESS } from "@/server/sync/sync-service";
import type { Citation, DocConflict, IdentifierCheck, RetrievalInfo, SourceKind } from "@/types/rag";

/**
 * Documentation retrieval: question -> intent -> FTS5 candidates -> ranking and
 * filtering -> a token-budgeted set of numbered excerpts.
 *
 * Search is lexical (SQLite FTS5 with Porter stemming, identifier splitting and exact
 * API-name lookup). There is no embedding model, so "semantic" matching is limited to
 * stemming, the Indonesian glossary in intent.ts and camelCase splitting.
 */

export interface RetrieveOptions {
  /** Most excerpts sent to the model. */
  maxChunks?: number;
  /** Budget for the documentation text, in estimated tokens. */
  maxContextTokens?: number;
  maxPerDocument?: number;
  candidateLimit?: number;
}

export const DEFAULT_LIMITS = { maxChunks: 8, maxContextTokens: 4500, maxPerDocument: 3, candidateLimit: 40 } as const;

const MIN_COVERAGE = 0.34;
const MIN_RELATIVE_SCORE = 0.6;
const MIN_ABSOLUTE_SCORE = 0.22;
const SNIPPET_CHARS = 280;

export interface SelectedChunk {
  n: number;
  chunkId: number;
  documentId: number;
  title: string;
  url: string;
  kind: SourceKind;
  heading: string | null;
  anchor: string | null;
  /** Already neutralized (see sanitize.ts) and cut to the budget. */
  text: string;
  truncated: boolean;
  score: number;
}

export interface Retrieval {
  info: RetrievalInfo;
  chunks: SelectedChunk[];
  intent: Intent;
}

interface Row {
  id: number;
  document_id: number;
  kind: SourceKind;
  heading: string | null;
  anchor: string | null;
  label: string | null;
  text: string;
  tokens: number;
  title: string;
  url: string;
}

interface Candidate {
  row: Row;
  /** Position in the bm25 order, or null when the chunk was found only by name. */
  rank: number | null;
  exact: number;
  coverage: number;
  score: number;
}

const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, "\\$&");

/** A crude stemmer applied to both sides of a comparison ("callbacks" = "callback"). */
export function stem(word: string): string {
  const w = word.toLowerCase();
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  for (const suffix of ["ing", "ed", "es", "s"]) if (w.length - suffix.length >= 4 && w.endsWith(suffix)) return w.slice(0, -suffix.length);
  return w;
}

const scalar = (db: Db, sql: string, ...args: Array<string | number>): number => Number((db.prepare(sql).get(...args) as { n: number }).n);

export function indexState(db: Db): RetrievalInfo["index"] {
  const documents = scalar(db, "SELECT COUNT(*) AS n FROM documents WHERE deleted_at IS NULL");
  const chunks = scalar(db, "SELECT COUNT(*) AS n FROM doc_chunks c JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL");
  const row = db.prepare("SELECT value FROM sync_metadata WHERE key = ?").get(META_LAST_SUCCESS) as { value: string } | undefined;
  return { documents, chunks, lastSyncAt: row?.value || null };
}

const empty = (status: RetrievalInfo["status"], reason: string, intent: Intent, index: RetrievalInfo["index"], candidates = 0, identifiers: IdentifierCheck[] = []): Retrieval => ({
  intent,
  chunks: [],
  info: {
    status, reason, intent: intent.kind, terms: intent.terms, candidates, documentsRetrieved: 0, sectionsSent: 0, tokensEstimate: 0,
    removedInstructionLines: 0, citations: [], identifiers, conflicts: [], index,
  },
});

/** FTS5 expression: OR of the content words and of each identifier as a phrase. */
function matchExpression(terms: string[], identifiers: string[]): string | null {
  const parts = new Set<string>();
  for (const t of terms) if (/^[\p{L}\p{N}]+$/u.test(t)) parts.add(quote(t));
  for (const id of identifiers) {
    const words = id.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.length > 0) parts.add(quote(words.join(" ")));
    for (const w of identifierWords(id).split(" ").filter(Boolean)) parts.add(quote(w));
  }
  return parts.size > 0 ? [...parts].join(" OR ") : null;
}

const SELECT_ROW = `c.id, c.document_id, c.kind, c.heading, c.anchor, c.label, c.text, c.tokens, d.title AS title, d.url AS url`;
const FROM_ROW = `doc_chunks c JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL`;

/** API entries whose name (or member name after ":" or ".") equals the identifier; case-insensitive. */
function apiChunksNamed(db: Db, identifier: string): Row[] {
  const member = identifier.split(/[:.]/).pop() ?? identifier;
  const exact = identifier.toLowerCase();
  const m = likeEscape(member.toLowerCase());
  return db
    .prepare(
      `SELECT ${SELECT_ROW} FROM ${FROM_ROW}
        WHERE c.kind = 'api' AND (lower(c.label) = ? OR lower(c.label) LIKE ? ESCAPE '\\' OR lower(c.label) LIKE ? ESCAPE '\\')
        ORDER BY (lower(c.label) = ?) DESC, c.id LIMIT 12`,
    )
    .all(exact, `%:${m}`, `%.${m}`, exact) as unknown as Row[];
}

function exactStrength(row: Row, identifier: string): number {
  const full = identifier.toLowerCase();
  const member = (identifier.split(/[:.]/).pop() ?? identifier).toLowerCase();
  const label = row.label?.toLowerCase() ?? null;
  if (label === full) return 1;
  if (label !== null && (label.endsWith(`:${member}`) || label.endsWith(`.${member}`) || label === member) && !identifier.includes(":") && !identifier.includes(".")) return 0.8;
  if (label !== null && label.endsWith(member) && label.split(/[:.]/).pop() === member) return 0.6;
  return new RegExp(`(^|[^A-Za-z0-9_])${full.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`, "i").test(row.text) ? 0.4 : 0;
}

function tokenSet(...texts: string[]): Set<string> {
  const set = new Set<string>();
  for (const text of texts) {
    for (const w of splitWords(text)) set.add(stem(w));
    for (const w of identifierWords(text).split(" ")) if (w) set.add(stem(w));
  }
  return set;
}

const normalizeSignature = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

function cutToBudget(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const head = text.slice(0, maxChars);
  const lineEnd = head.lastIndexOf("\n");
  const cut = lineEnd > maxChars * 0.5 ? head.slice(0, lineEnd) : head;
  // do not leave a code fence open
  const fences = (cut.match(/^\s{0,3}(`{3,}|~{3,})/gm) ?? []).length;
  return { text: `${cut.trimEnd()}${fences % 2 === 1 ? "\n```" : ""}\n[… shortened to fit the context budget]`, truncated: true };
}

export function retrieve(
  db: Db,
  messages: ReadonlyArray<{ role: string; content: string }>,
  options: RetrieveOptions = {},
): Retrieval {
  const limits = { ...DEFAULT_LIMITS, ...options };
  const users = messages.filter((m) => m.role === "user");
  const question = users[users.length - 1]?.content ?? "";
  const intent = detectIntent(question, { previousUser: users[users.length - 2]?.content });
  const index = indexState(db);

  if (index.chunks === 0) {
    return empty("unavailable", "No documentation is indexed yet. Run a synchronization in the Documentation page first.", intent, index);
  }
  if (!intent.searchable) {
    return empty("skipped", intent.kind === "smalltalk" ? "The message did not ask a documentation question." : "The message had no searchable words.", intent, index);
  }

  // ---- candidates ----------------------------------------------------------------
  const total = index.chunks;
  const dfOf = (term: string): number => scalar(db, "SELECT COUNT(*) AS n FROM search_chunks WHERE search_chunks MATCH ?", quote(term));
  const df = new Map<string, number>();
  let terms = intent.terms.filter((t) => /^[\p{L}\p{N}]+$/u.test(t));
  for (const t of terms) df.set(t, dfOf(t));
  if (total >= 20) {
    const rare = terms.filter((t) => (df.get(t) ?? 0) / total <= 0.45);
    if (rare.length > 0) terms = rare; // words found everywhere say nothing about what is asked
  }
  const idf = (t: string): number => {
    const n = df.get(t) ?? 0;
    return Math.log(1 + (total - n + 0.5) / (n + 0.5));
  };

  const byId = new Map<number, Candidate>();
  const expression = matchExpression(terms, intent.identifiers);
  if (expression) {
    const rows = db
      .prepare(
        `SELECT ${SELECT_ROW}, bm25(search_chunks, 6.0, 1.0, 3.0) AS bm
           FROM search_chunks
           JOIN doc_chunks c ON c.id = search_chunks.rowid
           JOIN documents d ON d.id = c.document_id AND d.deleted_at IS NULL
          WHERE search_chunks MATCH ? ORDER BY bm LIMIT ?`,
      )
      .all(expression, limits.candidateLimit) as unknown as Row[];
    rows.forEach((row, rank) => byId.set(row.id, { row, rank, exact: 0, coverage: 0, score: 0 }));
  }
  for (const id of intent.identifiers) {
    for (const row of apiChunksNamed(db, id)) if (!byId.has(row.id)) byId.set(row.id, { row, rank: null, exact: 0, coverage: 0, score: 0 });
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) {
    return empty("none_found", "The documentation index was searched but nothing matched the question.", intent, index, 0, verifyIdentifiers(db, intent.identifiers, []));
  }

  // ---- ranking --------------------------------------------------------------------
  const queryTerms = terms.map((t) => ({ term: stem(t), weight: idf(t) }));
  const denominator = queryTerms.reduce((n, q) => n + q.weight, 0) || 1;
  const kindFit = (kind: SourceKind): number => {
    if (intent.kind === "code_example") return kind === "code" ? 1 : 0.3;
    if (intent.kind === "api_lookup") return kind === "api" ? 1 : 0.3;
    if (intent.kind === "modify_script") return kind === "api" ? 1 : kind === "code" ? 0.6 : 0.3;
    return kind === "section" ? 0.6 : 0.4;
  };
  const maxRrf = 1 / 10;
  for (const c of candidates) {
    const tokens = tokenSet(c.row.title, c.row.heading ?? "", c.row.text);
    const covered = queryTerms.filter((q) => tokens.has(q.term)).reduce((n, q) => n + q.weight, 0);
    c.coverage = queryTerms.length > 0 ? covered / denominator : 0;
    c.exact = Math.max(0, ...intent.identifiers.map((id) => exactStrength(c.row, id)));
    const rrf = c.rank === null ? 0 : 1 / (10 + c.rank);
    const titleTokens = tokenSet(c.row.title, c.row.heading ?? "");
    const titleMatch = queryTerms.length > 0 ? queryTerms.filter((q) => titleTokens.has(q.term)).length / queryTerms.length : 0;
    c.score = 0.4 * c.coverage + 0.25 * (rrf / maxRrf) + 0.25 * c.exact + 0.05 * titleMatch + 0.05 * kindFit(c.row.kind);
  }
  candidates.sort((a, b) => b.score - a.score || a.row.id - b.row.id);
  const top = candidates[0]?.score ?? 0;
  const relevant = candidates.filter((c) => (c.coverage >= MIN_COVERAGE || c.exact >= 0.8) && c.score >= Math.max(MIN_ABSOLUTE_SCORE, MIN_RELATIVE_SCORE * top));
  if (relevant.length === 0) {
    return empty("none_found", "Sections matched a few words, but none was relevant enough to use.", intent, index, candidates.length, verifyIdentifiers(db, intent.identifiers, []));
  }

  // ---- selection (diversity, de-duplication, budget) ---------------------------------
  const picked: Candidate[] = [];
  const perDocument = new Map<number, number>();
  const wordsOf = (text: string): Set<string> => new Set(splitWords(text));
  const jaccard = (a: Set<string>, b: Set<string>): number => {
    let shared = 0;
    for (const w of a) if (b.has(w)) shared += 1;
    return shared / (a.size + b.size - shared || 1);
  };
  let budget = limits.maxContextTokens;
  const take = (c: Candidate, force = false): boolean => {
    if (picked.length >= limits.maxChunks && !force) return false;
    if ((perDocument.get(c.row.document_id) ?? 0) >= limits.maxPerDocument && c.exact < 0.8 && !force) return false;
    const words = wordsOf(c.row.text);
    for (const p of picked) {
      if (p.row.document_id === c.row.document_id && p.row.kind === "section" && c.row.kind === "code") {
        const body = c.row.text.replace(/^```[^\n]*\n|\n```$/g, "");
        if (p.row.text.includes(body.trim())) return false; // the same example already comes with its section
      }
      if (jaccard(words, wordsOf(p.row.text)) > 0.85) return false;
    }
    if (c.row.tokens > budget && picked.length > 0 && !force) return false;
    picked.push(c);
    perDocument.set(c.row.document_id, (perDocument.get(c.row.document_id) ?? 0) + 1);
    budget -= Math.min(c.row.tokens, budget);
    return true;
  };
  for (const c of relevant) take(c);

  // ---- conflicts: the same API documented differently on different pages ----------------
  // The other version of a conflicting API is added even when it exceeds the excerpt limits (it is still cut to the budget):
  // showing only one of two disagreeing pages would hide the disagreement.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    if (c.row.kind !== "api" || !c.row.label) continue;
    const key = c.row.label.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const conflictGroups: Candidate[][] = [];
  for (const group of groups.values()) {
    const docs = new Set(group.map((g) => g.row.document_id));
    const signatures = new Set(group.map((g) => normalizeSignature(g.row.text.split("\n")[1] ?? "")));
    if (docs.size > 1 && signatures.size > 1 && group.some((g) => picked.includes(g))) {
      conflictGroups.push(group);
      for (const g of group) if (!picked.includes(g)) take(g, true);
    }
  }

  // ---- build excerpts ----------------------------------------------------------------
  let remaining = limits.maxContextTokens * 3.6;
  let removedInstructionLines = 0;
  const chunks: SelectedChunk[] = [];
  const order = [...picked].sort((a, b) => b.score - a.score || a.row.id - b.row.id);
  for (const c of order) {
    const { text: safe, removed } = neutralizeUntrusted(c.row.text);
    removedInstructionLines += removed;
    const share = Math.max(400, Math.floor(remaining / Math.max(1, order.length - chunks.length)));
    const cut = cutToBudget(safe, chunks.length === 0 ? Math.max(share, Math.floor(remaining * 0.6)) : Math.max(share, 400));
    remaining -= cut.text.length;
    chunks.push({
      n: chunks.length + 1,
      chunkId: c.row.id,
      documentId: c.row.document_id,
      title: cleanField(c.row.title),
      url: cleanField(c.row.url, 500),
      kind: c.row.kind,
      heading: c.row.heading ? cleanField(c.row.heading) : null,
      anchor: c.row.anchor,
      text: cut.text,
      truncated: cut.truncated,
      score: Math.round(c.score * 1000) / 1000,
    });
  }

  const numberOf = (row: Row): number | undefined => chunks.find((x) => x.chunkId === row.id)?.n;
  const conflicts: DocConflict[] = conflictGroups.map((group) => ({
    name: group[0]?.row.label ?? "",
    sources: group.map((g) => numberOf(g.row)).filter((n): n is number => n !== undefined),
    note: "Different pages document this API differently (signature or parameters).",
  }));

  const citations: Citation[] = chunks.map((c) => ({
    n: c.n,
    documentId: c.documentId,
    title: c.title,
    section: c.heading,
    anchor: c.anchor,
    url: c.url,
    kind: c.kind,
    excerpt: excerpt(c.text),
    truncated: c.truncated,
  }));

  const info: RetrievalInfo = {
    status: "used",
    reason: null,
    intent: intent.kind,
    terms,
    candidates: candidates.length,
    documentsRetrieved: new Set(chunks.map((c) => c.documentId)).size,
    sectionsSent: chunks.length,
    tokensEstimate: chunks.reduce((n, c) => n + estimateTokens(c.text), 0),
    removedInstructionLines,
    citations,
    identifiers: verifyIdentifiers(db, intent.identifiers, chunks),
    conflicts,
    index,
  };
  return { info, chunks, intent };
}

function excerpt(text: string): string {
  const flat = text.replace(/^```[^\n]*\n?/, "").replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

/** Is each name from the question (or the user's script) a documented API entry? Never guessed: it is a lookup. */
export function verifyIdentifiers(db: Db, identifiers: string[], chunks: SelectedChunk[]): IdentifierCheck[] {
  const checks: IdentifierCheck[] = [];
  for (const name of identifiers.slice(0, 20)) {
    // Words that are plainly not API (plain camelCase variables) are still checked; "documented: false" is the honest answer.
    const rows = apiChunksNamed(db, name);
    const sources = chunks.filter((c) => rows.some((r) => r.id === c.chunkId)).map((c) => c.n);
    checks.push({ name, documented: rows.length > 0, sources });
  }
  return checks;
}
