import { Bot, User } from "lucide-react";

import { MarkdownRenderer } from "@/features/chat/markdown-renderer";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types";

interface MessageItemProps {
  message: ChatMessage;
}

export function MessageItem({ message }: MessageItemProps) {
  const isUser = message.role === "user";
  const Icon = isUser ? User : Bot;

  return (
    <article
      aria-label={isUser ? "Your message" : "Assistant message"}
      className={cn("flex gap-3 py-4", isUser && "flex-row-reverse")}
    >
      <div
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md",
          isUser
            ? "bg-secondary text-foreground"
            : "bg-primary text-primary-foreground",
        )}
      >
        <Icon className="size-4" aria-hidden="true" />
      </div>
      <div
        className={cn(
          "min-w-0 max-w-[85%] rounded-lg px-4 py-2",
          isUser ? "bg-secondary" : "border border-border bg-card",
        )}
      >
        <MarkdownRenderer source={message.content} />
      </div>
    </article>
  );
}
