import type { Db } from "@/server/db/database";
import { estimateTokens } from "@/server/rag/chunker";
import { detectIntent } from "@/server/rag/intent";
import { buildPrompt, type PromptExtras } from "@/server/rag/prompt";
import { indexState, retrieve, verifyIdentifiers, type Retrieval, type SelectedChunk } from "@/server/rag/retrieve";
import { cleanField } from "@/server/rag/sanitize";
import { analyzeRequest, type Analysis } from "@/server/lua/features";
import type { ChatRequest } from "@/types/ai";
import type { GenerationAnalysis } from "@/types/lua";
import type { Citation, DocConflict, RetrievalInfo } from "@/types/rag";

/**
 * The documentation workflow of the Lua script generator. For every request, in order:
 * analyse the request -> choose the documentation topics it needs -> search each topic
 * -> merge the excerpts (every topic gets its share) -> look up the documented APIs, events and
 * callbacks -> build the prompt. Retrieval is never skipped: the caller forces it.
 */

export interface GenerationLimits {
  maxChunks: number;
  maxContextTokens: number;
  /** Chunks kept from each topic before merging. */
  perTopic: number;
}

export const GENERATION_LIMITS: GenerationLimits = { maxChunks: 14, maxContextTokens: 6500, perTopic: 5 };

const MAX_LISTED_EVENTS = 60;
const MAX_LISTED_APIS = 40;

export interface PreparedGeneration {
  request: ChatRequest;
  context: RetrievalInfo;
  /** The script being modified, for the preservation check after the reply. */
  original: string | null;
}

const GENERATOR_RULES = [
  "SCRIPT GENERATOR MODE. The user wants a complete, working GTPS Lua script, or a modification of one. The server has already analysed the request and searched the documentation for it; its findings are in the \"Request analysis\" section of the user's message. Work in this order and never skip the documentation:",
  "1. Read the request analysis. Decide which GTPS APIs, events and callbacks the script needs.",
  "2. Use ONLY names that appear in the documentation excerpts, in the \"Verified API reference\" or in the \"Documented event and callback names\" list. Before you write a call, check its owner (for example Player:getName), exact spelling and letter case, parameter list and argument order. Before you write an event or callback name, check that it is in the lists. Give every required parameter.",
  "3. Standard Lua (string, table, math, os, io, pairs, pcall...) is not GTPS API. You may use it, but never present it as a GTPS function or cite a GTPS page for it. Avoid os, io, debug, load, loadstring, dofile and require unless the documentation says they are available.",
  "4. If the documentation lacks something the script needs, do not invent it. Say exactly what is missing (\"Missing documentation: ...\"), implement only what the documentation supports, and put a comment `-- NOT IMPLEMENTED: needs <what>` where the undocumented part would go. If the documentation is missing for most of the request, explain that and offer only the part that is documented.",
  "5. Code rules: documented APIs only; no invented methods, classes, fields or event names; follow the documented callback convention, including what the handler must return; keep it simple; use clear variable names; add useful comments; put settings the owner may change as constants at the top. The script must be COMPLETE: no \"...\" placeholders and no omitted parts. Put the whole script in exactly one fenced block labelled lua.",
  "6. When you modify a script the user gave you: read all of it, work out what it does now, keep every unrelated function, variable, name, comment and behavior exactly as it was, change only what was asked, and show the COMPLETE updated script (never a diff or an excerpt).",
  "",
  "Answer with exactly these level-2 headings, in this order (keep the headings in English whatever language the user writes in; write the content in the user's language):",
  "## Script name — a short name and a file name, for example `daily_reward.lua`.",
  "## Purpose — one or two sentences.",
  "## What changed — ONLY when modifying a script: the list of changes, and what was deliberately left untouched.",
  "## Complete Lua code — the one lua block.",
  "## Required configuration — the settings and values the owner must set or check, or \"None.\"",
  "## Installation instructions — only what the documentation excerpts say about installing or loading scripts; if they say nothing, say that and do not invent paths or commands.",
  "## Usage instructions — how players or admins use the script, with examples.",
  "## Explanation — how the script works, step by step, with [n] citations for documented behavior.",
  "## Documentation references — every excerpt you used as [n] with title, section and URL, and which documented API each one supports.",
  "## Known limitations — what is not implemented, what is assumed, and what you could not confirm from the documentation.",
].join("\n");

function section(chunk: SelectedChunk): string {
  return chunk.kind === "api" ? (chunk.heading ?? "") : "";
}

/**
 * One line per documented API entry: the entries among the excerpts first, then the other entries of the
 * pages the excerpts came from (a section about moderation is followed by its page's kick/mute signatures).
 */
function apiReference(db: Db, chunks: SelectedChunk[]): Array<{ name: string; line: string }> {
  const out: Array<{ name: string; line: string }> = [];
  const seen = new Set<string>();
  const push = (row: { name: string; signature: string; params_json: string; returns: string | null; kind: string | null }, n: number | null) => {
    if (out.length >= MAX_LISTED_APIS || seen.has(row.name)) return;
    seen.add(row.name);
    const params = safeParams(row.params_json);
    out.push({
      name: row.name,
      line: `- ${cleanField(row.signature, 160)}${n ? ` [${n}]` : ""}${row.kind ? ` — ${row.kind}` : ""}${params.length ? `; parameters: ${params.map((p) => cleanField(p, 40)).join(", ")}` : "; no parameters"}${row.returns ? `; returns ${cleanField(row.returns, 60)}` : ""}`,
    });
  };
  type Row = { name: string; signature: string; params_json: string; returns: string | null; kind: string | null };
  const byName = db.prepare("SELECT name, signature, params_json, returns, kind FROM api_entries WHERE name = ? AND document_id = ? LIMIT 1");
  for (const c of chunks) {
    const name = section(c);
    if (!name) continue;
    const row = byName.get(name, c.documentId) as Row | undefined;
    if (row) push(row, c.n);
  }
  const byDoc = db.prepare("SELECT name, signature, params_json, returns, kind FROM api_entries WHERE document_id = ? ORDER BY id");
  for (const c of chunks) {
    for (const row of byDoc.all(c.documentId) as Row[]) push(row, c.n);
  }
  return out;
}

function safeParams(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function documentedEvents(db: Db): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.name FROM api_entries a JOIN documents d ON d.id = a.document_id AND d.deleted_at IS NULL
        WHERE a.kind IN ('event', 'callback') ORDER BY a.name LIMIT ?`,
    )
    .all(MAX_LISTED_EVENTS + 1) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function merge(db: Db, analysis: Analysis, results: Array<{ topic: Analysis["topics"][number]; retrieval: Retrieval }>, limits: GenerationLimits): Retrieval {
  const picked: SelectedChunk[] = [];
  const byChunk = new Map<number, SelectedChunk>();
  let tokens = 0;
  const consider = (c: SelectedChunk, force = false): boolean => {
    if (byChunk.has(c.chunkId)) return false;
    const t = estimateTokens(c.text);
    if (!force && (picked.length >= limits.maxChunks || (picked.length > 0 && tokens + t > limits.maxContextTokens))) return false;
    byChunk.set(c.chunkId, c);
    picked.push(c);
    tokens += t;
    return true;
  };
  // Round-robin over the topics: each one gets its best excerpt before any gets its second.
  for (let i = 0; i < limits.perTopic; i++) for (const r of results) {
    const c = r.retrieval.chunks[i];
    if (c) consider(c);
  }
  // Conflicting versions of the same API are always kept together.
  for (const r of results) for (const conflict of r.retrieval.info.conflicts) {
    for (const n of conflict.sources) {
      const c = r.retrieval.chunks.find((x) => x.n === n);
      if (c) consider(c, true);
    }
  }

  const numberOf = new Map<number, number>();
  const chunks: SelectedChunk[] = picked.map((c, i) => {
    numberOf.set(c.chunkId, i + 1);
    return { ...c, n: i + 1 };
  });

  const conflicts: DocConflict[] = [];
  for (const r of results) for (const c of r.retrieval.info.conflicts) {
    const sources = c.sources
      .map((n) => r.retrieval.chunks.find((x) => x.n === n))
      .map((x) => (x ? numberOf.get(x.chunkId) : undefined))
      .filter((n): n is number => n !== undefined);
    if (sources.length >= 2 && !conflicts.some((x) => x.name === c.name)) conflicts.push({ ...c, sources });
  }

  const citations: Citation[] = chunks.map((c) => ({
    n: c.n, documentId: c.documentId, title: c.title, section: c.heading, anchor: c.anchor, url: c.url, kind: c.kind,
    excerpt: c.text.replace(/^```[^\n]*\n?/, "").replace(/\s+/g, " ").trim().slice(0, 280), truncated: c.truncated,
  }));

  const identifiers = [...new Set(results.flatMap((r) => r.retrieval.intent.identifiers))].slice(0, 20);
  const first = results[0]?.retrieval;
  const index = first?.info.index ?? indexState(db);
  const terms = [...new Set(results.flatMap((r) => r.retrieval.info.terms))].slice(0, 24);
  const failure = results.map((r) => r.retrieval.info).find((i) => i.status === "unavailable" || i.status === "error");
  const status: RetrievalInfo["status"] = chunks.length > 0 ? "used" : (failure?.status ?? "none_found");
  const info: RetrievalInfo = {
    status,
    reason: chunks.length > 0 ? null : (failure?.reason ?? "The documentation was searched for every topic of this request but nothing relevant was found."),
    intent: analysis.original !== null ? "modify_script" : "code_example",
    terms,
    candidates: results.reduce((n, r) => n + r.retrieval.info.candidates, 0),
    documentsRetrieved: new Set(chunks.map((c) => c.documentId)).size,
    sectionsSent: chunks.length,
    tokensEstimate: chunks.reduce((n, c) => n + estimateTokens(c.text), 0),
    removedInstructionLines: chunks.reduce((n, c) => n + (c.text.match(/\[line removed:/g)?.length ?? 0), 0),
    citations,
    identifiers: verifyIdentifiers(db, identifiers, chunks),
    conflicts,
    index,
  };
  return { info, chunks, intent: first?.intent ?? detectIntent(analysis.request) };
}

export function prepareGeneration(db: Db, request: ChatRequest, limits: GenerationLimits = GENERATION_LIMITS): PreparedGeneration {
  const analysis = analyzeRequest(request.messages);

  // Search every topic the request needs. One failing search must not hide the others.
  const results: Array<{ topic: Analysis["topics"][number]; retrieval: Retrieval }> = [];
  for (const topic of analysis.topics) {
    try {
      results.push({ topic, retrieval: retrieve(db, [{ role: "user", content: topic.query }], { maxChunks: limits.perTopic, maxContextTokens: Math.ceil(limits.maxContextTokens / 2), maxPerDocument: 3 }) });
    } catch {
      /* this topic found nothing: it is reported as missing below */
    }
  }
  const merged = merge(db, analysis, results, limits);

  const events = documentedEvents(db);
  const apis = apiReference(db, merged.chunks);
  const requiredApis = apis.map((a) => a.name);

  const topics = results.map((r) => ({ label: r.topic.label, query: r.topic.query.startsWith("```") ? "(the APIs the script already calls)" : r.topic.query.slice(0, 120), found: r.retrieval.chunks.length }));
  const generation: GenerationAnalysis = {
    features: analysis.features.map((f) => f.key),
    featureLabels: analysis.features.map((f) => f.label),
    modifying: analysis.original !== null,
    topics,
    missingTopics: topics.filter((t) => t.found === 0).map((t) => t.label),
    requiredApis,
  };
  merged.info.generation = generation;

  const brief = renderBrief(generation, apis.map((a) => a.line), events, merged.info);
  const extras: PromptExtras = { system: GENERATOR_RULES, brief };
  const prompt = buildPrompt(request.messages, merged, undefined, extras);
  const { docs: _docs, mode: _mode, ...rest } = request;
  void _docs;
  void _mode;
  return { request: { ...rest, messages: prompt.messages }, context: merged.info, original: analysis.original };
}

function renderBrief(g: GenerationAnalysis, apis: string[], events: string[], info: RetrievalInfo): string {
  const lines: string[] = ["Request analysis (computed by the server before you were called; counts are real):"];
  lines.push(`- Task: ${g.modifying ? "modify the existing script (it is in the user's message; keep unrelated functionality)" : "write a new script"}`);
  lines.push(`- Features recognised: ${g.featureLabels.length ? g.featureLabels.join("; ") : "none of the standard script types; use the request itself"}`);
  lines.push(`- Documentation topics searched (${g.topics.length}):`);
  for (const t of g.topics) lines.push(`  - ${cleanField(t.label, 80)}: ${t.found} excerpt(s) found`);
  if (g.missingTopics.length) lines.push(`- Topics with NO documentation found: ${g.missingTopics.map((m) => cleanField(m, 80)).join("; ")}. Do not invent APIs for these; follow rule 4.`);
  lines.push(`- Excerpts supplied: ${info.sectionsSent} from ${info.documentsRetrieved} page(s).`);
  if (info.status !== "used") lines.push("- NO documentation excerpts were found for this request. Follow rule 4: say what is missing and do not present guessed APIs as GTPS API.");
  lines.push("");
  lines.push(apis.length ? `Verified API reference (every line is an indexed API entry, a lookup; ${apis.length} listed):` : "Verified API reference: no API entries were found among the excerpts.");
  lines.push(...apis);
  lines.push("");
  const shown = events.slice(0, MAX_LISTED_EVENTS);
  lines.push(
    shown.length
      ? `Documented event and callback names (${events.length > MAX_LISTED_EVENTS ? `first ${MAX_LISTED_EVENTS}` : `all ${shown.length}`} in the index): ${shown.map((e) => cleanField(e, 80)).join(", ")}`
      : "Documented event and callback names: none are indexed. Do not use any event or callback name as if it were documented.",
  );
  return lines.join("\n");
}
