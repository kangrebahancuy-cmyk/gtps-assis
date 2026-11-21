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
  const [deleting, setDeleting] = useState<string | null>(null);

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
        <CardContent className="space-y-3 p-5">
          <p className="text-sm font-medium">Stored chats</p>
          {state.conversations.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-chats">No chats are stored.</p>
          ) : (
            <ul className="max-h-72 space-y-1 overflow-y-auto scrollbar-thin" aria-label="Stored chats" data-testid="stored-chats">
              {state.conversations.map((c) => (
                <li key={c.id} data-testid="stored-chat" className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{c.title}</span>
                    <span className="block text-xs text-muted-foreground">{c.messageCount} message(s) · {new Date(c.updatedAt).toLocaleString()}</span>
                  </span>
                  {deleting === c.id ? (
                    <span className="flex shrink-0 items-center gap-1">
                      <Button size="sm" variant="outline" onClick={async () => { setDeleting(null); await chat?.remove(c.id); }}>Delete this chat</Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="ghost" aria-label={`Delete chat ${c.title}`} onClick={() => setDeleting(c.id)}>Delete</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
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
