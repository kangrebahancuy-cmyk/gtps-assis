"use client";

import { ArrowUp, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useLayoutEffect, useRef } from "react";

import { Button } from "@/components/ui/button";
import { useChat } from "@/features/chat/chat-provider";
import { COMPOSER_ID } from "@/features/chat/welcome-screen";
import { MAX_INPUT_CHARS } from "@/lib/chat/controller";
import { modeOf } from "@/lib/chat/mode";
import { configuredProviders } from "@/lib/chat/models";

const MAX_HEIGHT_PX = 220;

export function Composer() {
  const { state, chat } = useChat();
  const hintId = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const { draftText, active } = state;
  const generating = state.generating.includes(active.id);
  const hasTarget = active.provider !== null && active.model !== null;
  const trimmed = draftText.trim();
  const canSend = state.ready && !generating && hasTarget && trimmed !== "" && draftText.length <= MAX_INPUT_CHARS;
  const noProvider = state.ready && configuredProviders(state.models.providers).length === 0;

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draftText]);

  // Ready to type when a chat is opened.
  useEffect(() => {
    if (state.ready) area.current?.focus();
  }, [state.ready, active.id]);

  function submit() {
    if (canSend) void chat?.send(draftText);
  }

  return (
    <div className="border-t border-border px-4 py-3 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        {state.notice ? (
          <div
            role={state.notice.tone === "error" ? "alert" : "status"}
            className={`mb-2 flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm ${state.notice.tone === "error" ? "border-destructive/40 bg-destructive/10" : "border-border bg-card"}`}
          >
            <span>{state.notice.text}</span>
            <button type="button" onClick={() => chat?.dismissNotice()} className="shrink-0 text-xs text-muted-foreground underline" aria-label="Dismiss message">
              Dismiss
            </button>
          </div>
        ) : null}

        <div className="flex items-end gap-2 rounded-xl border border-input bg-card p-2 transition-colors focus-within:border-ring">
          <textarea
            id={COMPOSER_ID}
            ref={area}
            value={draftText}
            onChange={(event) => chat?.setDraftText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return; // an input method is choosing a character
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape" && generating) {
                event.preventDefault();
                void chat?.stop();
              }
            }}
            rows={1}
            placeholder={modeOf(active) === "generate" ? "Describe the script you want, or paste one to modify" : "Message GTPS Assistant"}
            aria-label="Message"
            aria-describedby={hintId}
            className="max-h-56 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-2.5 text-sm placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          {generating ? (
            <Button size="icon" variant="secondary" onClick={() => void chat?.stop()} aria-label="Stop generating" title="Stop generating (Esc)">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button size="icon" disabled={!canSend} onClick={submit} aria-label="Send message" title={noProvider ? "Connect an AI provider first" : !hasTarget ? "Choose a provider and model first" : "Send (Enter)"}>
              <ArrowUp />
            </Button>
          )}
        </div>

        <p id={hintId} className="mt-2 flex flex-wrap items-center justify-center gap-x-3 text-center text-xs text-muted-foreground">
          {noProvider ? (
            <span>
              No AI provider connected.{" "}
              <Link href="/settings/providers" className="underline underline-offset-2">
                Open settings
              </Link>
            </span>
          ) : (
            <span>Enter to send · Shift+Enter for a new line{generating ? " · Esc to stop" : ""}</span>
          )}
          {draftText.length > MAX_INPUT_CHARS * 0.9 ? (
            <span className={draftText.length > MAX_INPUT_CHARS ? "text-destructive" : undefined}>
              {draftText.length.toLocaleString("en-US")} / {MAX_INPUT_CHARS.toLocaleString("en-US")}
            </span>
          ) : null}
        </p>
      </div>
    </div>
  );
}
