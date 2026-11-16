import { isProviderId } from "@/types/ai";
import type { ApiUse, Finding, GenerationAnalysis, ScriptCheck } from "@/types/lua";
import type { Citation, RetrievalInfo } from "@/types/rag";
import { EXPORT_FORMAT, EXPORT_VERSION, type ChatSnapshot, type ExportedConversation, type ExportFile, type MessageMeta, type MessageStatus, type StoredMessage } from "@/lib/chat/types";

/** Export and import of the chat history as one JSON file. Contains no API keys: they are never stored in the browser. */

export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;
const MAX_CONVERSATIONS = 5000;
const MAX_MESSAGES_PER_CONVERSATION = 5000;
const MAX_CONTENT = 1_000_000;
const MAX_TITLE = 200;

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportError";
  }
}

export function buildExport(snapshot: ChatSnapshot, now = new Date()): ExportFile {
  const byConversation = new Map<string, StoredMessage[]>();
  for (const message of snapshot.messages) {
    const list = byConversation.get(message.conversationId) ?? [];
    list.push(message);
    byConversation.set(message.conversationId, list);
  }
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    conversations: snapshot.conversations.map((c) => ({
      ...c,
      messages: (byConversation.get(c.id) ?? []).sort((a, b) => a.order - b.order),
    })),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string") throw new ImportError(`${what} must be text.`);
  if (v.length > max) throw new ImportError(`${what} is too long.`);
  return v;
};
const time = (v: unknown, what: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new ImportError(`${what} must be a timestamp.`);
  return Math.floor(v);
};
const idOf = (v: unknown, what: string): string => {
  const id = str(v, what, 200);
  if (id === "") throw new ImportError(`${what} is empty.`);
  return id;
};
const RETRIEVAL_STATUSES: readonly string[] = ["used", "none_found", "skipped", "unavailable", "error"];
const SOURCE_KINDS: readonly string[] = ["section", "api", "code"];
const INTENTS: readonly string[] = ["smalltalk", "api_lookup", "code_example", "modify_script", "how_to", "general"];
const STATUSES: readonly string[] = ["complete", "streaming", "stopped", "error", "interrupted"];

const text = (x: unknown, max: number): string | null => (typeof x === "string" ? x.slice(0, max) : null);
const count = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);

/** Keeps the documentation search record of a reply only when it has the expected shape. */
function parseRetrieval(value: unknown): RetrievalInfo | null {
  if (!isObject(value) || !RETRIEVAL_STATUSES.includes(String(value.status))) return null;
  const citations: Citation[] = [];
  for (const c of Array.isArray(value.citations) ? value.citations.slice(0, 40) : []) {
    if (!isObject(c)) continue;
    const title = text(c.title, 300);
    const url = text(c.url, 1000);
    if (title === null || url === null || !SOURCE_KINDS.includes(String(c.kind))) continue;
    citations.push({
      n: count(c.n), documentId: count(c.documentId), title, section: text(c.section, 300), anchor: text(c.anchor, 200), url,
      kind: c.kind as Citation["kind"], excerpt: text(c.excerpt, 600) ?? "", truncated: c.truncated === true,
    });
  }
  const index = isObject(value.index) ? value.index : {};
  return {
    status: value.status as RetrievalInfo["status"],
    reason: text(value.reason, 500),
    intent: (INTENTS.includes(String(value.intent)) ? value.intent : "general") as RetrievalInfo["intent"],
    terms: Array.isArray(value.terms) ? value.terms.filter((t): t is string => typeof t === "string").slice(0, 20).map((t) => t.slice(0, 60)) : [],
    candidates: count(value.candidates),
    documentsRetrieved: count(value.documentsRetrieved),
    sectionsSent: count(value.sectionsSent),
    tokensEstimate: count(value.tokensEstimate),
    removedInstructionLines: count(value.removedInstructionLines),
    citations,
    identifiers: Array.isArray(value.identifiers)
      ? value.identifiers.filter(isObject).slice(0, 30).map((i) => ({ name: text(i.name, 100) ?? "", documented: i.documented === true, sources: Array.isArray(i.sources) ? i.sources.map(count).slice(0, 20) : [] }))
      : [],
    conflicts: Array.isArray(value.conflicts)
      ? value.conflicts.filter(isObject).slice(0, 20).map((c) => ({ name: text(c.name, 100) ?? "", sources: Array.isArray(c.sources) ? c.sources.map(count).slice(0, 20) : [], note: text(c.note, 300) ?? "" }))
      : [],
    index: { documents: count(index.documents), chunks: count(index.chunks), lastSyncAt: text(index.lastSyncAt, 40) },
    ...(parseGeneration(value.generation) ? { generation: parseGeneration(value.generation) as GenerationAnalysis } : {}),
  };
}

const strings = (x: unknown, max: number, each = 120): string[] => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string").slice(0, max).map((v) => v.slice(0, each)) : []);

function parseGeneration(value: unknown): GenerationAnalysis | null {
  if (!isObject(value)) return null;
  return {
    features: strings(value.features, 12, 40),
    featureLabels: strings(value.featureLabels, 12, 80),
    modifying: value.modifying === true,
    topics: Array.isArray(value.topics)
      ? value.topics.filter(isObject).slice(0, 12).map((t) => ({ label: text(t.label, 120) ?? "", query: text(t.query, 160) ?? "", found: count(t.found) }))
      : [],
    missingTopics: strings(value.missingTopics, 12),
    requiredApis: strings(value.requiredApis, 60, 80),
  };
}

const FINDING_KINDS = ["syntax", "incomplete", "undocumented_api", "wrong_arguments", "unknown_event", "callback_signature", "lua_standard", "restricted_lua", "unverified_call", "removed_feature", "changed_feature", "preservation_skipped"];
const API_STATUSES = ["documented", "undocumented", "lua_standard", "unresolved"];
const API_KINDS = ["function", "method", "callback", "event"];

function parseScriptCheck(value: unknown): ScriptCheck | null {
  if (!isObject(value) || !isObject(value.syntax) || !isObject(value.stats)) return null;
  const syntax: ScriptCheck["syntax"] =
    value.syntax.ok === true
      ? { ok: true }
      : { ok: false, message: text(value.syntax.message, 400) ?? "", line: count(value.syntax.line), column: count(value.syntax.column) };
  const preservation = isObject(value.preservation)
    ? { preserved: strings(value.preservation.preserved, 60, 160), modified: strings(value.preservation.modified, 60, 160), removed: strings(value.preservation.removed, 60, 160), added: strings(value.preservation.added, 60, 160) }
    : null;
  return {
    syntax,
    stats: { lines: count(value.stats.lines), functions: count(value.stats.functions), calls: count(value.stats.calls), units: count(value.stats.units) },
    apiUses: Array.isArray(value.apiUses)
      ? value.apiUses.filter(isObject).slice(0, 120).flatMap((u): ApiUse[] => {
          const name = text(u.name, 120);
          if (name === null || !API_STATUSES.includes(String(u.status))) return [];
          const source = isObject(u.source) && text(u.source.url, 1000) !== null ? { documentId: count(u.source.documentId), title: text(u.source.title, 300) ?? "", url: text(u.source.url, 1000) ?? "" } : null;
          return [{
            name, status: u.status as ApiUse["status"], documentedAs: text(u.documentedAs, 120), signature: text(u.signature, 200),
            kind: API_KINDS.includes(String(u.kind)) ? (u.kind as ApiUse["kind"]) : null, source,
            lines: Array.isArray(u.lines) ? u.lines.map(count).slice(0, 30) : [], suggestion: text(u.suggestion, 120),
          }];
        })
      : [],
    findings: Array.isArray(value.findings)
      ? value.findings.filter(isObject).slice(0, 80).flatMap((f): Finding[] => {
          const message = text(f.message, 600);
          if (message === null || !FINDING_KINDS.includes(String(f.kind)) || !["error", "warning", "info"].includes(String(f.severity))) return [];
          return [{ kind: f.kind as Finding["kind"], severity: f.severity as Finding["severity"], message, line: typeof f.line === "number" ? count(f.line) : null, name: text(f.name, 120) }];
        })
      : [],
    preservation,
    passed: value.passed === true,
  };
}

function parseMeta(value: unknown): MessageMeta {
  if (!isObject(value)) return {};
  const meta: MessageMeta = {};
  if (value.finishReason === "stop" || value.finishReason === "length" || value.finishReason === "blocked" || value.finishReason === "other") meta.finishReason = value.finishReason;
  if (isObject(value.usage)) {
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    meta.usage = { inputTokens: n(value.usage.inputTokens), outputTokens: n(value.usage.outputTokens), totalTokens: n(value.usage.totalTokens) };
  }
  if (isObject(value.error) && typeof value.error.kind === "string" && typeof value.error.message === "string") {
    meta.error = {
      kind: value.error.kind as never,
      message: value.error.message.slice(0, 500),
      retryAfterMs: typeof value.error.retryAfterMs === "number" ? value.error.retryAfterMs : null,
    };
  }
  if (value.edited === true) meta.edited = true;
  const docs = parseRetrieval(value.docs);
  if (docs) meta.docs = docs;
  const check = parseScriptCheck(value.check);
  if (check) meta.check = check;
  if (value.requestMode === "chat" || value.requestMode === "generate") meta.requestMode = value.requestMode;
  return meta;
}

/**
 * Validates an exported file and returns clean conversations. Anything that
 * is not the expected shape is rejected with a readable message; nothing is
 * trusted (no prototype keys, bounded sizes, unknown fields dropped).
 */
export function parseImport(text: string): ExportedConversation[] {
  if (text.length > MAX_IMPORT_BYTES) throw new ImportError("The file is too large to import.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportError("This file is not valid JSON.");
  }
  if (!isObject(raw) || raw.format !== EXPORT_FORMAT) throw new ImportError("This is not a GTPS Assistant chat export.");
  if (raw.version !== EXPORT_VERSION) throw new ImportError(`Unsupported export version ${String(raw.version)}.`);
  if (!Array.isArray(raw.conversations)) throw new ImportError("The export has no conversations list.");
  if (raw.conversations.length > MAX_CONVERSATIONS) throw new ImportError("The export has too many conversations.");

  const seen = new Set<string>();
  return raw.conversations.map((c, index): ExportedConversation => {
    const where = `Conversation ${index + 1}`;
    if (!isObject(c)) throw new ImportError(`${where} is not an object.`);
    const id = idOf(c.id, `${where}: id`);
    if (seen.has(id)) throw new ImportError(`${where}: duplicate id.`);
    seen.add(id);
    if (!Array.isArray(c.messages)) throw new ImportError(`${where}: messages must be a list.`);
    if (c.messages.length > MAX_MESSAGES_PER_CONVERSATION) throw new ImportError(`${where}: too many messages.`);

    const messageIds = new Set<string>();
    const messages = c.messages.map((m, i): StoredMessage => {
      const mw = `${where}, message ${i + 1}`;
      if (!isObject(m)) throw new ImportError(`${mw} is not an object.`);
      const mid = idOf(m.id, `${mw}: id`);
      if (messageIds.has(mid)) throw new ImportError(`${mw}: duplicate id.`);
      messageIds.add(mid);
      if (m.role !== "user" && m.role !== "assistant") throw new ImportError(`${mw}: role must be user or assistant.`);
      const status = STATUSES.includes(String(m.status)) ? (m.status as MessageStatus) : "complete";
      return {
        id: mid,
        conversationId: id,
        order: i,
        role: m.role,
        content: str(m.content, `${mw}: content`, MAX_CONTENT),
        createdAt: time(m.createdAt, `${mw}: createdAt`),
        updatedAt: time(m.updatedAt ?? m.createdAt, `${mw}: updatedAt`),
        // A reply that was still streaming when the file was exported never finished.
        status: status === "streaming" ? "interrupted" : status,
        provider: isProviderId(m.provider) ? m.provider : null,
        model: typeof m.model === "string" ? m.model.slice(0, 128) : null,
        meta: parseMeta(m.meta),
      };
    });

    const metadata: Record<string, string | number | boolean | null> = {};
    if (isObject(c.metadata)) {
      for (const [k, v] of Object.entries(c.metadata)) {
        if (k === "__proto__" || k.length > 64) continue;
        if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") metadata[k] = typeof v === "string" ? v.slice(0, 500) : v;
      }
    }
    return {
      id,
      title: str(c.title, `${where}: title`, MAX_TITLE).trim() || "Untitled chat",
      titleSource: c.titleSource === "manual" ? "manual" : "auto",
      createdAt: time(c.createdAt, `${where}: createdAt`),
      updatedAt: time(c.updatedAt ?? c.createdAt, `${where}: updatedAt`),
      provider: isProviderId(c.provider) ? c.provider : null,
      model: typeof c.model === "string" ? c.model.slice(0, 128) : null,
      messageCount: messages.length,
      metadata,
      messages,
    };
  });
}
