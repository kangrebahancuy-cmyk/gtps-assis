"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useChat } from "@/features/chat/chat-provider";
import { downloadText } from "@/lib/download";

/** Export, import and clearing of the chat history stored in this browser (IndexedDB). */
export function ChatHistoryPanel() {
  const { state, chat } = useChat();
  const file = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const chats = state.conversations.length;
  const messages = state.conversations.reduce((n, c) => n + c.messageCount, 0);

  async function onExport() {
    if (!chat) return;
    setBusy(true);
    try {
      const { filename, text, conversations } = await chat.exportJson();
      downloadText(filename, text);
      setMessage({ tone: "ok", text: `Exported ${conversations} chat(s) to ${filename}.` });
    } catch {
      setMessage({ tone: "error", text: "Could not export the history." });
    } finally {
      setBusy(false);
    }
  }

  async function onImport(selected: File | undefined) {
    if (!chat || !selected) return;
    setBusy(true);
    setMessage(null);
    try {
      await chat.importJson(await selected.text());
    } catch {
      setMessage({ tone: "error", text: "Could not read that file." });
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <p className="text-sm font-medium">Chat history</p>
            <p className="text-sm text-muted-foreground" data-testid="history-counts">
              {state.ready ? `${chats} chat(s), ${messages} message(s) stored in this browser (IndexedDB).` : "Loading…"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              History needs no account and stays on this device. Exported files contain your conversations (never API keys).
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" disabled={busy || chats === 0} onClick={() => void onExport()}>
              Export JSON
            </Button>
            <Button variant="outline" size="sm" disabled={busy || !state.ready} onClick={() => file.current?.click()}>
              Import JSON
            </Button>
            <input ref={file} type="file" accept="application/json,.json" className="sr-only" aria-label="Import chat history file" onChange={(event) => void onImport(event.target.files?.[0])} />
            {confirming ? (
              <span className="flex items-center gap-2 text-sm">
                Delete all {chats} chat(s)?
                <Button
                  variant="outline"
                  size="sm"
                  onClick={async () => {
                    setConfirming(false);
                    await chat?.clearAll();
                  }}
                >
                  Yes, delete everything
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button variant="outline" size="sm" disabled={busy || chats === 0} onClick={() => setConfirming(true)}>
                Clear all history
              </Button>
            )}
          </div>
          {message ? (
            <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>
              {message.text}
            </p>
          ) : null}
          {state.notice ? (
            <p role={state.notice.tone === "error" ? "alert" : "status"} className={state.notice.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>
              {state.notice.text}
            </p>
          ) : null}
          {state.persistenceNote ? <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">{state.persistenceNote}</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-1 p-5 text-sm">
          <p className="font-medium">Keyboard shortcuts</p>
          <p className="text-muted-foreground">Enter sends · Shift+Enter adds a new line · Esc stops a reply · Ctrl/Cmd+Enter saves an edited message.</p>
        </CardContent>
      </Card>
    </div>
  );
}
