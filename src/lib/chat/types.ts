import type { AiErrorKind, FinishReason, ProviderId } from "@/types/ai";
import type { ChatMode } from "@/lib/chat/mode";
import type { ScriptCheck } from "@/types/lua";
import type { RetrievalInfo } from "@/types/rag";

/** Data model of the chat history. Everything here is stored locally in the browser (IndexedDB). */

export type MessageRole = "user" | "assistant";

/**
 * complete:    finished normally.
 * streaming:   being generated right now (only ever in memory, or in the database if the page was closed mid-reply).
 * stopped:     the user pressed Stop; the partial text is kept.
 * error:       the provider or network failed; partial text, if any, is kept.
 * interrupted: found in the database as "streaming" after a reload: the page closed before the reply finished.
 */
export type MessageStatus = "complete" | "streaming" | "stopped" | "error" | "interrupted";

export interface MessageError {
  kind: AiErrorKind;
  message: string;
  retryAfterMs: number | null;
}

export interface MessageMeta {
  finishReason?: FinishReason;
  usage?: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  error?: MessageError;
  /** The user edited this message after sending it. */
  edited?: boolean;
  /** What the documentation search found for this reply (sources, counts). Absent when documentation search was off. */
  docs?: RetrievalInfo;
  /** Generator replies: the script in the reply checked against the documentation. */
  check?: ScriptCheck;
  /** User messages: how this one was sent, when it differs from the conversation's mode (e.g. "Explain Code" in a generator chat). */
  requestMode?: ChatMode;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  /** Position in the conversation, starting at 0. */
  order: number;
  role: MessageRole;
  content: string;
  createdAt: number;
  updatedAt: number;
  status: MessageStatus;
  /** For assistant messages: which provider/model produced the text. */
  provider: ProviderId | null;
  model: string | null;
  meta: MessageMeta;
}

export interface Conversation {
  id: string;
  title: string;
  /** auto: derived from the first message. manual: set by the user (never overwritten). */
  titleSource: "auto" | "manual";
  createdAt: number;
  updatedAt: number;
  /** Provider and model selected for this conversation (remembered per conversation). */
  provider: ProviderId | null;
  model: string | null;
  messageCount: number;
  metadata: Record<string, string | number | boolean | null>;
}

export interface SearchHit {
  conversationId: string;
  title: string;
  updatedAt: number;
  /** Where the match is: the title, or the text of a message. */
  matchedIn: "title" | "message";
  messageId: string | null;
  snippet: string | null;
}

export const EXPORT_FORMAT = "gtps-assistant-chat-export";
export const EXPORT_VERSION = 1;

export interface ExportedConversation extends Conversation {
  messages: StoredMessage[];
}

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  conversations: ExportedConversation[];
}

export interface ImportResult {
  conversations: number;
  messages: number;
  /** Conversations skipped because one with the same id already exists. */
  skipped: number;
}

export interface ChatSnapshot {
  conversations: Conversation[];
  messages: StoredMessage[];
}

/** Everything the controller needs from storage. Two implementations: IndexedDB and in-memory. */
export interface ChatRepository {
  readonly kind: "indexeddb" | "memory";
  /** Newest activity first. */
  listConversations(): Promise<Conversation[]>;
  getConversation(id: string): Promise<Conversation | null>;
  /** Messages of a conversation in order. */
  getMessages(conversationId: string): Promise<StoredMessage[]>;
  /** Atomic write: conversation, messages to add/replace, messages to remove. */
  commit(change: { conversation?: Conversation; put?: StoredMessage[]; removeMessageIds?: string[] }): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  clearAll(): Promise<void>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  /** Everything stored, for export. */
  snapshot(): Promise<ChatSnapshot>;
  /** Adds conversations that do not exist yet, in one transaction. */
  importConversations(conversations: ExportedConversation[]): Promise<ImportResult>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
  close(): void;
}
