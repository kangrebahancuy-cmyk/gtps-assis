"use client";

import { ChatHeader } from "@/features/chat/chat-header";
import { Composer } from "@/features/chat/composer";
import { MessageList } from "@/features/chat/message-list";
import { useHydrated } from "@/hooks/use-hydrated";
import { useChatStore } from "@/store/chat-store";

export function ChatView() {
  const hydrated = useHydrated();
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);

  const session = hydrated
    ? sessions.find((s) => s.id === activeSessionId)
    : undefined;

  return (
    <div className="flex h-full flex-col">
      <ChatHeader title={session?.title ?? "New chat"} />
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <MessageList messages={session?.messages ?? []} />
      </div>
      <Composer />
    </div>
  );
}
