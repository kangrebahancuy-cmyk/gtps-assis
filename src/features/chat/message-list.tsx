import { MessageSquareText } from "lucide-react";

import { MessageItem } from "@/features/chat/message-item";
import type { ChatMessage } from "@/types";

interface MessageListProps {
  messages: readonly ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-secondary">
          <MessageSquareText className="size-5 text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 className="text-base font-medium">No messages yet</h2>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          This is the message area. Conversations will appear here once an AI
          provider is connected in a later step.
        </p>
      </div>
    );
  }

  return (
    <div
      role="log"
      aria-live="polite"
      className="mx-auto w-full max-w-3xl px-4 sm:px-6"
    >
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} />
      ))}
    </div>
  );
}
