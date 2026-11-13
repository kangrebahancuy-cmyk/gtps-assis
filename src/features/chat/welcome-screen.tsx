"use client";

import { MessageSquareText } from "lucide-react";
import Link from "next/link";

import { useChat } from "@/features/chat/chat-provider";
import { EXAMPLE_PROMPTS } from "@/lib/constants";
import { configuredProviders } from "@/lib/chat/models";

export const COMPOSER_ID = "composer-input";

/** Shown in an empty chat. Picking a prompt fills the composer so it can be adjusted before sending. */
export function WelcomeScreen() {
  const { state, chat } = useChat();
  const connected = configuredProviders(state.models.providers).length > 0;
  const loadingModels = state.models.status === "idle" || state.models.status === "loading";

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8 text-center">
      <div className="mb-3 flex size-10 items-center justify-center rounded-lg bg-secondary">
        <MessageSquareText className="size-5 text-muted-foreground" aria-hidden="true" />
      </div>
      <h2 className="text-xl font-semibold tracking-tight">What are you building today?</h2>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">Ask about GTPS Lua scripting, or pick an example to start.</p>

      {!connected && !loadingModels ? (
        <p className="mt-4 max-w-md rounded-md border border-border bg-card px-3 py-2 text-sm" role="status">
          No AI provider is connected yet.{" "}
          <Link href="/settings/providers" className="text-primary underline underline-offset-2">
            Add a Gemini or Groq API key
          </Link>{" "}
          to start chatting.
        </p>
      ) : null}

      <ul className="mt-6 grid w-full max-w-2xl gap-2 sm:grid-cols-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => {
                chat?.setDraftText(prompt);
                document.getElementById(COMPOSER_ID)?.focus();
              }}
              className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">The assistant doesn&apos;t have the GTPS Cloud documentation yet, so check API details it gives you.</p>
    </div>
  );
}
