"use client";

import { MessageSquare, Pencil, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { useChat } from "@/features/chat/chat-provider";
import type { Conversation } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

interface HistoryListProps {
  /** Called after a chat is opened or created, e.g. to go to /chat or to close the mobile drawer. */
  onOpenChat?: () => void;
}

function Row({ conversation, snippet, active, generating, onOpenChat }: { conversation: Conversation; snippet: string | null; active: boolean; generating: boolean; onOpenChat?: () => void }) {
  const { chat } = useChat();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const [title, setTitle] = useState(conversation.title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "rename") {
      input.current?.focus();
      input.current?.select();
    }
  }, [mode]);

  if (mode === "rename") {
    return (
      <li className="px-1 py-0.5">
        <label className="sr-only" htmlFor={`rename-${conversation.id}`}>
          Chat title
        </label>
        <Input
          id={`rename-${conversation.id}`}
          ref={input}
          value={title}
          maxLength={120}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={() => setMode("view")}
          onKeyDown={async (event) => {
            if (event.key === "Escape") setMode("view");
            if (event.key === "Enter") {
              event.preventDefault();
              if (await chat?.rename(conversation.id, title)) setMode("view");
            }
          }}
          className="h-8"
        />
      </li>
    );
  }

  if (mode === "delete") {
    return (
      <li className="rounded-md bg-accent/60 px-2 py-1.5 text-sm">
        <p className="truncate">Delete “{conversation.title}”?</p>
        <div className="mt-1 flex gap-2">
          <button type="button" className="rounded bg-destructive px-2 py-0.5 text-xs text-destructive-foreground" onClick={() => void chat?.remove(conversation.id)} aria-label={`Confirm delete ${conversation.title}`}>
            Delete
          </button>
          <button type="button" className="rounded border border-border px-2 py-0.5 text-xs" onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => {
          void chat?.select(conversation.id);
          onOpenChat?.();
        }}
        onDoubleClick={() => {
          setTitle(conversation.title);
          setMode("rename");
        }}
        aria-current={active ? "true" : undefined}
        className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-14 text-left text-sm transition-colors hover:bg-accent", active && "bg-accent text-accent-foreground")}
      >
        <MessageSquare className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate">{conversation.title}</span>
          {snippet ? <span className="block truncate text-xs text-muted-foreground">{snippet}</span> : null}
        </span>
        {generating ? (
          <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" role="status" aria-label="Generating a reply" />
        ) : null}
      </button>
      <div className="absolute right-1 top-1/2 flex -translate-y-1/2 items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => {
            setTitle(conversation.title);
            setMode("rename");
          }}
          aria-label={`Rename chat ${conversation.title}`}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setMode("delete")} aria-label={`Delete chat ${conversation.title}`} className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground">
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

/** Chat history: search (titles and message text), open, rename, delete. */
export function HistoryList({ onOpenChat }: HistoryListProps) {
  const { state, chat } = useChat();
  const [query, setQuery] = useState("");

  // Search as the user types, after a short pause.
  useEffect(() => {
    const timer = window.setTimeout(() => void chat?.search(query), 150);
    return () => window.clearTimeout(timer);
  }, [query, chat]);

  const searching = query.trim() !== "";
  const hits = state.search.hits;
  const rows: Array<{ conversation: Conversation; snippet: string | null }> =
    searching && hits
      ? hits.flatMap((h) => {
          const conversation = state.conversations.find((c) => c.id === h.conversationId);
          return conversation ? [{ conversation, snippet: h.snippet }] : [];
        })
      : state.conversations.map((conversation) => ({ conversation, snippet: null }));

  return (
    <>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5.5 top-1/2 size-4 -translate-y-[calc(50%+4px)] text-muted-foreground" aria-hidden="true" />
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" className="pl-8" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
        <h2 className="px-2 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Chat History</h2>
        {!state.ready ? null : rows.length === 0 ? (
          <p className="px-2 py-2 text-sm text-muted-foreground" role="status">
            {searching ? (state.search.pending ? "Searching…" : "No chats match your search.") : "No chats yet."}
          </p>
        ) : (
          <ul className="space-y-0.5" aria-label="Chats">
            {rows.map(({ conversation, snippet }) => (
              <Row key={conversation.id} conversation={conversation} snippet={snippet} active={!state.isDraft && conversation.id === state.active.id} generating={state.generating.includes(conversation.id)} onOpenChat={onOpenChat} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
