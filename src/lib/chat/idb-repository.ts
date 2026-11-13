import { searchConversations } from "@/lib/chat/search";
import type { ChatRepository, ChatSnapshot, Conversation, ExportedConversation, ImportResult, SearchHit, StoredMessage } from "@/lib/chat/types";

export const CHAT_DB_NAME = "gtps-assistant-chat";
const DB_VERSION = 1;
const CONVERSATIONS = "conversations";
const MESSAGES = "messages";
const META = "meta";

const request = <T,>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

/**
 * Runs the writes of one transaction. If one of them throws (for example a record
 * that cannot be stored), the whole transaction is aborted so no partial change is kept.
 */
function writes(tx: IDBTransaction, finished: Promise<void>, run: () => void): void {
  try {
    run();
  } catch (error) {
    finished.catch(() => {});
    try {
      tx.abort();
    } catch {
      // already finished
    }
    throw error;
  }
}

/**
 * Chat history in IndexedDB (database "gtps-assistant-chat"):
 *   conversations  key: id, index updatedAt
 *   messages       key: id, index conversationId
 *   meta           key: key   (small UI preferences such as the last open chat)
 * Every multi-record write is one transaction, so a crash never leaves half a change.
 */
export class IndexedDbChatRepository implements ChatRepository {
  readonly kind = "indexeddb" as const;

  private constructor(private db: IDBDatabase) {
    // Another tab upgrading the database, or the browser closing the connection: release it.
    db.onversionchange = () => db.close();
  }

  /** Rejects when IndexedDB is unavailable, blocked (some private modes) or fails to open. */
  static open(factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB, name = CHAT_DB_NAME): Promise<IndexedDbChatRepository> {
    if (!factory) return Promise.reject(new Error("IndexedDB is not available in this browser."));
    return new Promise((resolve, reject) => {
      let opening: IDBOpenDBRequest;
      try {
        opening = factory.open(name, DB_VERSION);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("IndexedDB could not be opened."));
        return;
      }
      opening.onupgradeneeded = () => {
        const db = opening.result;
        const conversations = db.createObjectStore(CONVERSATIONS, { keyPath: "id" });
        conversations.createIndex("updatedAt", "updatedAt");
        const messages = db.createObjectStore(MESSAGES, { keyPath: "id" });
        messages.createIndex("conversationId", "conversationId");
        db.createObjectStore(META, { keyPath: "key" });
      };
      opening.onsuccess = () => resolve(new IndexedDbChatRepository(opening.result));
      opening.onerror = () => reject(opening.error ?? new Error("IndexedDB could not be opened."));
      opening.onblocked = () => reject(new Error("IndexedDB is blocked by another tab using an older version."));
    });
  }

  async listConversations(): Promise<Conversation[]> {
    const tx = this.db.transaction(CONVERSATIONS, "readonly");
    const all = await request(tx.objectStore(CONVERSATIONS).getAll() as IDBRequest<Conversation[]>);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const tx = this.db.transaction(CONVERSATIONS, "readonly");
    return ((await request(tx.objectStore(CONVERSATIONS).get(id))) as Conversation | undefined) ?? null;
  }

  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    const tx = this.db.transaction(MESSAGES, "readonly");
    const all = await request(tx.objectStore(MESSAGES).index("conversationId").getAll(conversationId) as IDBRequest<StoredMessage[]>);
    return all.sort((a, b) => a.order - b.order);
  }

  async commit(change: { conversation?: Conversation; put?: StoredMessage[]; removeMessageIds?: string[] }): Promise<void> {
    const tx = this.db.transaction([CONVERSATIONS, MESSAGES], "readwrite");
    const finished = done(tx);
    writes(tx, finished, () => {
      if (change.conversation) tx.objectStore(CONVERSATIONS).put(change.conversation);
      const messages = tx.objectStore(MESSAGES);
      for (const m of change.put ?? []) messages.put(m);
      for (const id of change.removeMessageIds ?? []) messages.delete(id);
    });
    await finished;
  }

  async deleteConversation(id: string): Promise<void> {
    const tx = this.db.transaction([CONVERSATIONS, MESSAGES], "readwrite");
    const finished = done(tx);
    tx.objectStore(CONVERSATIONS).delete(id);
    const messages = tx.objectStore(MESSAGES);
    const keys = await request(messages.index("conversationId").getAllKeys(id));
    for (const key of keys) messages.delete(key);
    await finished;
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction([CONVERSATIONS, MESSAGES, META], "readwrite");
    const finished = done(tx);
    tx.objectStore(CONVERSATIONS).clear();
    tx.objectStore(MESSAGES).clear();
    tx.objectStore(META).clear();
    await finished;
  }

  async snapshot(): Promise<ChatSnapshot> {
    const tx = this.db.transaction([CONVERSATIONS, MESSAGES], "readonly");
    const [conversations, messages] = await Promise.all([
      request(tx.objectStore(CONVERSATIONS).getAll() as IDBRequest<Conversation[]>),
      request(tx.objectStore(MESSAGES).getAll() as IDBRequest<StoredMessage[]>),
    ]);
    return { conversations, messages };
  }

  async search(query: string, limit?: number): Promise<SearchHit[]> {
    const { conversations, messages } = await this.snapshot();
    return searchConversations(conversations, messages, query, limit);
  }

  async importConversations(incoming: ExportedConversation[]): Promise<ImportResult> {
    const tx = this.db.transaction([CONVERSATIONS, MESSAGES], "readwrite");
    const finished = done(tx);
    const conversations = tx.objectStore(CONVERSATIONS);
    const messages = tx.objectStore(MESSAGES);
    const existingConversations = new Set((await request(conversations.getAllKeys())) as string[]);
    const takenMessageIds = new Set((await request(messages.getAllKeys())) as string[]);
    const result: ImportResult = { conversations: 0, messages: 0, skipped: 0 };

    for (const { messages: list, ...conversation } of incoming) {
      if (existingConversations.has(conversation.id)) {
        result.skipped += 1;
        continue;
      }
      writes(tx, finished, () => {
        conversations.put(conversation);
        existingConversations.add(conversation.id);
        for (const m of list) {
          // A message id that already belongs to another conversation must not overwrite it.
          const id = takenMessageIds.has(m.id) ? `${m.id}~${conversation.id}` : m.id;
          takenMessageIds.add(id);
          messages.put({ ...m, id, conversationId: conversation.id });
          result.messages += 1;
        }
      });
      result.conversations += 1;
    }
    await finished;
    return result;
  }

  async getMeta(key: string): Promise<string | null> {
    const tx = this.db.transaction(META, "readonly");
    const row = (await request(tx.objectStore(META).get(key))) as { key: string; value: string } | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    const tx = this.db.transaction(META, "readwrite");
    const finished = done(tx);
    if (value === null) tx.objectStore(META).delete(key);
    else tx.objectStore(META).put({ key, value });
    await finished;
  }

  close(): void {
    this.db.close();
  }
}

/** IndexedDB when it works, otherwise a memory repository and the reason (so the UI can warn that history will not survive a reload). */
export async function openChatRepository(): Promise<{ repository: ChatRepository; fallbackReason: string | null }> {
  try {
    return { repository: await IndexedDbChatRepository.open(), fallbackReason: null };
  } catch (error) {
    const { MemoryChatRepository } = await import("@/lib/chat/memory-repository");
    return { repository: new MemoryChatRepository(), fallbackReason: error instanceof Error ? error.message : "IndexedDB is unavailable." };
  }
}

/** Deletes the whole chat database (used by "Clear local data"). Resolves when done, or after a short wait if another tab keeps it open. */
export function deleteChatDatabase(factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB, name = CHAT_DB_NAME): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      const req = factory.deleteDatabase(name);
      req.onsuccess = finish;
      req.onerror = finish;
      req.onblocked = () => {}; // wait: our own connection closes itself on versionchange
    } catch {
      finish();
    }
  });
}
