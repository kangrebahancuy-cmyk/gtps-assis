import type { Conversation } from "@/lib/chat/types";

/** "chat" answers questions; "generate" is the Lua script generator (documentation workflow + script check). */
export type ChatMode = "chat" | "generate";

export function modeOf(conversation: Pick<Conversation, "metadata">): ChatMode {
  return conversation.metadata.mode === "generate" ? "generate" : "chat";
}
