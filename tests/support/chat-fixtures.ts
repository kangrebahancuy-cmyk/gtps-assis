import type { Conversation, StoredMessage } from "@/lib/chat/types";

export function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id,
    title: `Chat ${id}`,
    titleSource: "auto",
    createdAt: 1000,
    updatedAt: 1000,
    provider: "groq",
    model: "llama-demo-70b",
    messageCount: 0,
    metadata: {},
    ...over,
  };
}

export function msg(conversationId: string, order: number, over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: `${conversationId}-m${order}`,
    conversationId,
    order,
    role: order % 2 === 0 ? "user" : "assistant",
    content: `message ${order} of ${conversationId}`,
    createdAt: 1000 + order,
    updatedAt: 1000 + order,
    status: "complete",
    provider: order % 2 === 0 ? null : "groq",
    model: order % 2 === 0 ? null : "llama-demo-70b",
    meta: {},
    ...over,
  };
}
