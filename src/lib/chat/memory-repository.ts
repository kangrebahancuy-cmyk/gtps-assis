import { searchConversations } from "@/lib/chat/search";
import type { ChatRepository, ChatSnapshot, Conversation, ExportedConversation, ImportResult, SearchHit, StoredMessage } from "@/lib/chat/types";

const copy = <T,>(value: T): T => structuredClone(value);

/** In-memory repository: used in tests and as the fallback when IndexedDB is unavailable (history is then lost on reload). */
export class MemoryChatRepository implements ChatRepository {
  readonly kind = "memory" as const;
  private conversations = new Map<string, Conversation>();
  private messages = new Map<string, StoredMessage>();
  private meta = new Map<string, string>();

  async listConversations(): Promise<Conversation[]> {
    return [...this.conversations.values()].map(copy).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async getConversation(id: string): Promise<Conversation | null> {
    const c = this.conversations.get(id);
    return c ? copy(c) : null;
  }
  async getMessages(conversationId: string): Promise<StoredMessage[]> {
    return [...this.messages.values()].filter((m) => m.conversationId === conversationId).map(copy).sort((a, b) => a.order - b.order);
  }
  async commit(change: { conversation?: Conversation; put?: StoredMessage[]; removeMessageIds?: string[] }): Promise<void> {
    if (change.conversation) this.conversations.set(change.conversation.id, copy(change.conversation));
    for (const m of change.put ?? []) this.messages.set(m.id, copy(m));
    for (const id of change.removeMessageIds ?? []) this.messages.delete(id);
  }
  async deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    for (const [key, m] of this.messages) if (m.conversationId === id) this.messages.delete(key);
  }
  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.meta.clear();
  }
  async search(query: string, limit?: number): Promise<SearchHit[]> {
    return searchConversations([...this.conversations.values()], [...this.messages.values()], query, limit);
  }
  async snapshot(): Promise<ChatSnapshot> {
    return { conversations: [...this.conversations.values()].map(copy), messages: [...this.messages.values()].map(copy) };
  }
  async importConversations(incoming: ExportedConversation[]): Promise<ImportResult> {
    const result: ImportResult = { conversations: 0, messages: 0, skipped: 0 };
    for (const { messages, ...conversation } of incoming) {
      if (this.conversations.has(conversation.id)) {
        result.skipped += 1;
        continue;
      }
      this.conversations.set(conversation.id, copy(conversation));
      for (const m of messages) {
        // A message id that already belongs to another conversation must not overwrite it.
        const id = this.messages.has(m.id) ? `${m.id}~${conversation.id}` : m.id;
        this.messages.set(id, copy({ ...m, id, conversationId: conversation.id }));
        result.messages += 1;
      }
      result.conversations += 1;
    }
    return result;
  }
  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
  close(): void {}
}
