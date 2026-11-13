"use client";

import { ChatHeader } from "@/features/chat/chat-header";
import { useChat } from "@/features/chat/chat-provider";
import { Composer } from "@/features/chat/composer";
import { MessageList } from "@/features/chat/message-list";
import { WelcomeScreen } from "@/features/chat/welcome-screen";

export function ChatView() {
  const { state } = useChat();
  const busy = state.generating.includes(state.active.id);

  return (
    <div className="flex h-full flex-col">
      <ChatHeader />
      {state.persistenceNote ? (
        <p role="alert" className="border-b border-border bg-amber-500/10 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 sm:px-6">
          {state.persistenceNote}
        </p>
      ) : null}
      {!state.ready ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground" role="status">
          Loading chat…
        </div>
      ) : state.messages.length === 0 ? (
        <WelcomeScreen />
      ) : (
        <MessageList conversationId={state.active.id} messages={state.messages} busy={busy} />
      )}
      <Composer />
    </div>
  );
}
