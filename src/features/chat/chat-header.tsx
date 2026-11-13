"use client";

import { useChat } from "@/features/chat/chat-provider";
import { ModelSelector } from "@/features/chat/model-selector";
import { PROVIDER_LABELS } from "@/lib/chat/models";

export function ChatHeader() {
  const { state } = useChat();
  const problems = state.models.catalogs.filter((c) => c.error !== null);

  return (
    <div className="border-b border-border px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="min-w-0 flex-1 truncate text-sm font-medium" title={state.active.title}>
          {state.active.title}
        </h1>
        <ModelSelector />
      </div>
      {problems.map((c) => (
        <p key={c.provider} role="status" className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {PROVIDER_LABELS[c.provider]}: {c.error?.message}
          {c.stale ? " Showing the last model list that loaded." : ""}
        </p>
      ))}
    </div>
  );
}
