"use client";

import { ArrowUp } from "lucide-react";
import { useId } from "react";

import { Button } from "@/components/ui/button";
import { useChatStore } from "@/store/chat-store";

export function Composer() {
  const draft = useChatStore((state) => state.composerDraft);
  const setDraft = useChatStore((state) => state.setComposerDraft);
  const hintId = useId();

  return (
    <div className="border-t border-border px-4 py-3 sm:px-6">
      <div className="mx-auto w-full max-w-3xl">
        <div className="flex items-end gap-2 rounded-xl border border-input bg-card p-2 transition-colors focus-within:border-ring">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            rows={2}
            placeholder="Message GTPS Assistant"
            aria-label="Message"
            aria-describedby={hintId}
            className="max-h-48 min-h-[44px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
          />
          <Button
            size="icon"
            disabled
            aria-label="Send message (unavailable: no AI provider connected)"
            title="Sending is unavailable until an AI provider is connected"
          >
            <ArrowUp />
          </Button>
        </div>
        <p id={hintId} className="mt-2 text-center text-xs text-muted-foreground">
          Sending is disabled: no AI provider is connected yet.
        </p>
      </div>
    </div>
  );
}
