import type { Conversation, SearchHit, StoredMessage } from "@/lib/chat/types";

/** Case-insensitive search: every word of the query must appear in the title, or in a single message. */
export function searchConversations(conversations: readonly Conversation[], messages: readonly StoredMessage[], query: string, limit = 50): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const hasAll = (text: string) => {
    const lower = text.toLowerCase();
    return terms.every((t) => lower.includes(t));
  };

  const firstHit = new Map<string, StoredMessage>();
  for (const message of messages) {
    if (firstHit.has(message.conversationId) && message.order > (firstHit.get(message.conversationId)?.order ?? 0)) continue;
    if (hasAll(message.content)) firstHit.set(message.conversationId, message);
  }

  const hits: SearchHit[] = [];
  for (const conversation of conversations) {
    if (hasAll(conversation.title)) {
      hits.push({ conversationId: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, matchedIn: "title", messageId: null, snippet: null });
      continue;
    }
    const message = firstHit.get(conversation.id);
    if (message) {
      hits.push({
        conversationId: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updatedAt,
        matchedIn: "message",
        messageId: message.id,
        snippet: snippetAround(message.content, terms[0] ?? ""),
      });
    }
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** About 80 characters of context around the first occurrence of `term`, on one line. */
export function snippetAround(text: string, term: string, radius = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const at = term ? flat.toLowerCase().indexOf(term.toLowerCase()) : -1;
  if (at === -1) return flat.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + term.length + radius);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}
