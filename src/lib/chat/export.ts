import { isProviderId } from "@/types/ai";
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
const STATUSES: readonly string[] = ["complete", "streaming", "stopped", "error", "interrupted"];

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
