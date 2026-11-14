"use client";

import { AlertTriangle, Bot, Check, Copy, Pencil, RefreshCw, User } from "lucide-react";
import Link from "next/link";
import { memo, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useChat } from "@/features/chat/chat-provider";
import { MarkdownRenderer } from "@/features/chat/markdown-renderer";
import { SourcesPanel } from "@/features/chat/sources-panel";
import { errorHint } from "@/lib/ai-format";
import { copyText } from "@/lib/clipboard";
import { PROVIDER_LABELS } from "@/lib/chat/models";
import type { StoredMessage } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

interface MessageItemProps {
  message: StoredMessage;
  /** The last message of the conversation: the only reply that can be regenerated. */
  isLast: boolean;
  /** A reply is being generated in this conversation: edit and regenerate are unavailable. */
  busy: boolean;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 1500);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <Button variant="ghost" size="sm" onClick={async () => setState((await copyText(text)) ? "copied" : "failed")} aria-label={label} title={label}>
      {state === "copied" ? <Check /> : <Copy />}
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
    </Button>
  );
}

function UserBubble({ message, busy }: { message: StoredMessage; busy: boolean }) {
  const { chat } = useChat();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(message.content);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      area.current?.focus();
      area.current?.setSelectionRange(value.length, value.length);
    }
    // only when entering edit mode
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function submit() {
    const text = value.trim();
    if (text === "") return;
    setEditing(false);
    void chat?.editMessage(message.id, text);
  }

  if (editing) {
    return (
      <div className="w-full max-w-[85%] space-y-2 rounded-lg border border-ring bg-card p-2">
        <textarea
          ref={area}
          value={value}
          rows={Math.min(10, Math.max(2, value.split("\n").length))}
          aria-label="Edit your message"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setEditing(false);
              setValue(message.content);
            } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
          className="w-full resize-y bg-transparent px-2 py-1.5 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <p className="px-2 text-xs text-muted-foreground">Saving removes the replies after this message and asks again.</p>
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(false);
              setValue(message.content);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" disabled={value.trim() === ""} onClick={submit}>
            Save &amp; submit
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/message flex min-w-0 max-w-[85%] flex-col items-end gap-1">
      <div className="min-w-0 rounded-lg bg-secondary px-4 py-2">
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed" data-testid="user-text">
          {message.content}
        </p>
      </div>
      <div className="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:focus-within:opacity-100 sm:group-hover/message:opacity-100">
        {message.meta.edited ? <span className="px-1 text-xs text-muted-foreground">edited</span> : null}
        <CopyButton text={message.content} label="Copy message" />
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setValue(message.content);
            setEditing(true);
          }}
          aria-label="Edit message"
          title={busy ? "Stop the reply to edit" : "Edit message"}
        >
          <Pencil />
          Edit
        </Button>
      </div>
    </div>
  );
}

function AssistantBubble({ message, isLast, busy }: MessageItemProps) {
  const { chat } = useChat();
  const streaming = message.status === "streaming";
  const error = message.meta.error;
  const who = message.model ? `${message.provider ? PROVIDER_LABELS[message.provider] : "Assistant"} · ${message.model}` : "Assistant";
  const canRegenerate = isLast && !busy;
  const hint = error ? errorHint({ ...error, provider: null, status: null, retryable: false }) : null;

  return (
    <div className="min-w-0 max-w-[85%] flex-1">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <span data-testid="assistant-label">{who}</span>
        <time dateTime={new Date(message.createdAt).toISOString()} title={new Date(message.createdAt).toLocaleString()}>
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
      <div className="min-w-0 rounded-lg border border-border bg-card px-4 py-2" aria-busy={streaming}>
        {message.content === "" && streaming ? (
          <p className="flex items-center gap-1 py-1 text-sm text-muted-foreground" role="status">
            <span className="sr-only">Generating a reply</span>
            <span aria-hidden="true" className="inline-flex gap-1">
              {[0, 1, 2].map((i) => (
                <span key={i} className="size-1.5 animate-pulse rounded-full bg-muted-foreground" style={{ animationDelay: `${i * 150}ms` }} />
              ))}
            </span>
          </p>
        ) : message.content !== "" ? (
          <div data-testid="assistant-text">
            <MarkdownRenderer source={message.content} />
            {streaming ? <span aria-hidden="true" className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-foreground/70 align-middle" /> : null}
          </div>
        ) : null}

        {message.status === "stopped" ? <p className="py-1 text-xs text-muted-foreground">Generation stopped.</p> : null}
        {message.status === "interrupted" ? <p className="py-1 text-xs text-amber-600 dark:text-amber-400">This reply was interrupted: the page was closed before it finished.</p> : null}
        {message.meta.finishReason === "length" && message.status === "complete" ? <p className="py-1 text-xs text-muted-foreground">The reply was cut off because it reached the length limit.</p> : null}
        {message.status === "complete" && message.content === "" ? <p className="py-1 text-xs text-muted-foreground">The model returned an empty reply.</p> : null}

        <SourcesPanel message={message} />

        {error ? (
          <div role="alert" className="my-2 flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
            <div className="min-w-0 space-y-1">
              <p className="break-words">{error.message}</p>
              {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
              {error.kind === "invalid_key" || error.kind === "not_configured" || error.kind === "permission_denied" ? (
                <Link href="/settings/providers" className="text-xs text-primary underline underline-offset-2">
                  Open AI Providers settings
                </Link>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {!streaming ? (
        <div className="mt-1 flex items-center gap-1">
          {message.content !== "" ? <CopyButton text={message.content} label="Copy response" /> : null}
          {canRegenerate ? (
            <Button variant="ghost" size="sm" onClick={() => void chat?.regenerate()} aria-label={error ? "Try again" : "Regenerate response"} title={error ? "Try again" : "Regenerate response"}>
              <RefreshCw />
              {error ? "Try again" : "Regenerate"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function MessageItemBase(props: MessageItemProps) {
  const isUser = props.message.role === "user";
  const Icon = isUser ? User : Bot;
  return (
    <article aria-label={isUser ? "Your message" : "Assistant message"} data-role={props.message.role} data-status={props.message.status} className={cn("flex gap-3 py-4", isUser && "flex-row-reverse")}>
      <div className={cn("flex size-7 shrink-0 items-center justify-center rounded-md", isUser ? "bg-secondary text-foreground" : "bg-primary text-primary-foreground")}>
        <Icon className="size-4" aria-hidden="true" />
      </div>
      {isUser ? <UserBubble message={props.message} busy={props.busy} /> : <AssistantBubble {...props} />}
    </article>
  );
}

/** Re-renders only when its own message (or the flags) change, so a streaming reply does not redraw the whole conversation. */
export const MessageItem = memo(MessageItemBase);
