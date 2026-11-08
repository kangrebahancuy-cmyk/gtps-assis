"use client";

import { BookOpen, Code2, Cpu, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";

import { FeatureCard } from "@/features/dashboard/feature-card";
import { APP_NAME, APP_TAGLINE, EXAMPLE_PROMPTS } from "@/lib/constants";
import { useChatStore } from "@/store/chat-store";

export function DashboardView() {
  const router = useRouter();
  const startNewChat = useChatStore((state) => state.startNewChat);
  const setComposerDraft = useChatStore((state) => state.setComposerDraft);

  function handlePrompt(prompt: string) {
    startNewChat();
    setComposerDraft(prompt);
    router.push("/chat");
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-10 sm:px-6 sm:py-14">
      <section className="mb-10 text-center sm:mb-12">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {APP_NAME}
        </h1>
        <p className="mt-3 text-base text-muted-foreground">{APP_TAGLINE}</p>
      </section>

      <section aria-labelledby="features-heading" className="mb-10">
        <h2 id="features-heading" className="sr-only">
          Features
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <FeatureCard
            href="/chat"
            icon={Sparkles}
            title="AI Lua Script Generator"
            description="Describe what you need and get GTPS-ready Lua."
            status="Not available yet"
          />
          <FeatureCard
            href="/docs"
            icon={BookOpen}
            title="GTPS Documentation Explorer"
            description="Browse and search GTPS Cloud documentation."
            status="Layout only"
          />
          <FeatureCard
            href="/workspace"
            icon={Code2}
            title="Lua Code Workspace"
            description="Edit Lua files in a focused editor workspace."
            status="Editor preview"
          />
          <FeatureCard
            href="/settings/models"
            icon={Cpu}
            title="AI Model Configuration"
            description="Choose providers and models for your assistant."
            status="Not available yet"
          />
        </div>
      </section>

      <section aria-labelledby="prompts-heading">
        <h2
          id="prompts-heading"
          className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground"
        >
          Example prompts
        </h2>
        <ul className="grid gap-2 sm:grid-cols-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => handlePrompt(prompt)}
                className="w-full rounded-lg border border-border bg-card px-4 py-3 text-left text-sm transition-colors hover:border-primary/40 hover:bg-accent/40"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          Selecting a prompt opens a new chat and fills the composer. Sending
          is disabled until an AI provider is connected.
        </p>
      </section>
    </div>
  );
}
