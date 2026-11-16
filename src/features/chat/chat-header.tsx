"use client";

import { useChat } from "@/features/chat/chat-provider";
import { ContextIndicator } from "@/features/chat/context-indicator";
import { ModelSelector } from "@/features/chat/model-selector";
import { Badge } from "@/components/ui/badge";
import { modeOf } from "@/lib/chat/mode";
import { PROVIDER_LABELS } from "@/lib/chat/models";

export function ChatHeader() {
  const { state } = useChat();
  const problems = state.models.catalogs.filter((c) => c.error !== null);

  return (
    <div className="border-b border-border px-4 py-2.5 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium" title={state.active.title}>
          {modeOf(state.active) === "generate" ? <Badge data-testid="mode-badge">Script Generator</Badge> : null}
          <span className="truncate">{state.active.title}</span>
        </h1>
        <ModelSelector />
      </div>
      <ContextIndicator />
      {problems.map((c) => (
        <p key={c.provider} role="status" className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {PROVIDER_LABELS[c.provider]}: {c.error?.message}
          {c.stale ? " Showing the last model list that loaded." : ""}
        </p>
      ))}
    </div>
  );
}
