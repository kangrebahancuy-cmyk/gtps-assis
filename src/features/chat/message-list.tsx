"use client";

import { ArrowDown } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { MessageItem } from "@/features/chat/message-item";
import type { StoredMessage } from "@/lib/chat/types";

interface MessageListProps {
  conversationId: string;
  messages: readonly StoredMessage[];
  /** A reply is being generated in this conversation. */
  busy: boolean;
}

const NEAR_BOTTOM_PX = 80;

/**
 * The scrolling conversation. It follows new text while the reader is at the
 * bottom, stops following when they scroll up to read, and offers a button to
 * jump back down. Sending a message or opening a chat always goes to the bottom.
 */
export function MessageList({ conversationId, messages, busy }: MessageListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [away, setAway] = useState(false);
  const lastConversation = useRef(conversationId);
  const lastCount = useRef(messages.length);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);

  const toBottom = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    lastTop.current = el.scrollTop;
    lastHeight.current = el.scrollHeight;
  }, []);

  const tail = messages[messages.length - 1];
  useLayoutEffect(() => {
    const switched = lastConversation.current !== conversationId;
    const sent = messages.length > lastCount.current && messages[messages.length - 2]?.role === "user";
    lastConversation.current = conversationId;
    lastCount.current = messages.length;
    if (switched || sent) {
      following.current = true;
      setAway(false);
    }
    const el = scroller.current;
    // The reader may have scrolled up a moment ago, before the browser reported it. If the content has not
    // shrunk and the position went up, respect that instead of pulling them back down.
    const readerWentUp = !!el && !switched && !sent && el.scrollHeight >= lastHeight.current && el.scrollTop < lastTop.current - 2;
    if (following.current && readerWentUp) {
      following.current = false;
      setAway(true);
    } else if (following.current) toBottom();
    // the text of the last message changes while streaming
  }, [conversationId, messages, tail?.content, tail?.status, toBottom]);

  function onScroll() {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollTop;
    const near = el.scrollHeight - top - el.clientHeight < NEAR_BOTTOM_PX;
    // Reaching the bottom resumes following. Only an upward move by the reader stops it: text arriving
    // faster than the browser reports our own scrolling must not look like the reader leaving.
    if (near) following.current = true;
    else if (top < lastTop.current - 2) following.current = false;
    lastTop.current = top;
    lastHeight.current = el.scrollHeight;
    setAway(!following.current);
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto scrollbar-thin" data-testid="message-scroller">
        <div role="log" aria-label="Conversation" aria-busy={busy} className="mx-auto w-full max-w-3xl px-4 sm:px-6">
          {messages.map((message, index) => (
            <MessageItem key={message.id} message={message} isLast={index === messages.length - 1} busy={busy} />
          ))}
        </div>
      </div>
      {away ? (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow"
          onClick={() => {
            following.current = true;
            setAway(false);
            toBottom();
          }}
          aria-label="Scroll to latest message"
        >
          <ArrowDown />
          {busy ? "New text below" : "Latest"}
        </Button>
      ) : null}
    </div>
  );
}
