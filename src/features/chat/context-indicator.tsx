"use client";

import { useChat } from "@/features/chat/chat-provider";
import { useDocsContext } from "@/features/chat/use-docs-context";
import { citedNumbers } from "@/lib/chat/citations";
import { modeOf } from "@/lib/chat/mode";
import { formatDateTime } from "@/lib/format";
import type { StoredMessage } from "@/lib/chat/types";

const NONE = "—";

/** The documentation search of the newest reply that has one. */
function lastSearch(messages: readonly StoredMessage[]): StoredMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "assistant" && m.meta.docs) return m;
  }
  return null;
}

/**
 * Four facts about documentation search, all read from the backend and from the record
 * of the latest reply. When something is unknown or did not happen it says so instead of showing a number.
 */
export function ContextIndicator() {
  const { state, chat } = useChat();
  const context = useDocsContext(`${state.generating.length}|${state.active.id}`);
  const message = lastSearch(state.messages);
  const docs = message?.meta.docs ?? null;
  const generator = modeOf(state.active) === "generate";

  let search: string;
  if (!generator && !state.docsSearch) search = "Off";
  else if (context.phase === "loading") search = "Checking…";
  else if (context.phase === "unreachable") search = "Unknown (backend unreachable)";
  else search = context.status.available ? "Active" : "Unavailable (no documentation indexed)";

  const retrieved = docs?.status === "used" ? String(docs.documentsRetrieved) : docs?.status === "none_found" ? "0" : NONE;
  const used = message && docs?.status === "used" ? String(citedNumbers(message.content, docs.citations).length) : docs?.status === "none_found" ? "0" : NONE;
  const sync = context.phase === "ready" ? formatDateTime(context.status.lastSyncAt, "Never synchronized") : NONE;
  const why = !docs ? "Nothing searched yet in this chat" : docs.status === "skipped" ? "The last message did not need documentation" : docs.status === "used" ? "From the last reply" : (docs.reason ?? "Nothing was retrieved for the last reply");

  return (
    <div role="group" aria-label="Documentation context" data-testid="context-indicator" className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {generator ? (
        <span title="The script generator always searches the documentation first">
          Documentation Search: <strong data-testid="ctx-search" className="font-medium text-foreground">{search} (always on)</strong>
        </span>
      ) : (
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={state.docsSearch} onChange={(event) => chat?.setDocsSearch(event.target.checked)} aria-label="Search documentation before answering" />
          <span>
            Documentation Search: <strong data-testid="ctx-search" className="font-medium text-foreground">{search}</strong>
          </span>
        </label>
      )}
      <span title={why}>
        Documents Retrieved: <strong data-testid="ctx-retrieved" className="font-medium text-foreground">{retrieved}</strong>
      </span>
      <span title="Sources the last answer cites with [n]">
        Sources Used: <strong data-testid="ctx-used" className="font-medium text-foreground">{used}</strong>
      </span>
      <span title="When the documentation was last synchronized successfully">
        Last Documentation Sync: <strong data-testid="ctx-sync" className="font-medium text-foreground">{sync}</strong>
      </span>
    </div>
  );
}
