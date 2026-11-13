"use client";

import { RefreshCw } from "lucide-react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { useChat } from "@/features/chat/chat-provider";
import { configuredProviders, PROVIDER_LABELS, selectableModels } from "@/lib/chat/models";
import type { ProviderId } from "@/types/ai";

const SELECT_CLASS = "h-8 max-w-[11rem] rounded-md border border-input bg-transparent px-2 text-xs sm:max-w-[16rem]";

/** Provider and model pickers for the open conversation. The choice is stored with that conversation. */
export function ModelSelector() {
  const { state, chat } = useChat();
  const { models, active } = state;
  const providers = configuredProviders(models.providers);
  const busy = models.status === "loading";

  if (models.status === "idle" || (busy && providers.length === 0)) {
    return <span className="text-xs text-muted-foreground">Loading models…</span>;
  }
  if (models.status === "unreachable" || (models.status === "error" && providers.length === 0)) {
    return (
      <div className="flex items-center gap-2 text-xs text-destructive" role="alert">
        <span>{models.status === "unreachable" ? "Can't reach the local backend." : "Couldn't load models."}</span>
        <Button variant="outline" size="sm" onClick={() => void chat?.refreshModels()}>
          Retry
        </Button>
      </div>
    );
  }
  if (providers.length === 0) {
    return (
      <Link href="/settings/providers" className="text-xs text-primary underline underline-offset-2">
        Connect a provider to start chatting
      </Link>
    );
  }

  const available = selectableModels(models.catalogs, active.provider);
  const providerKnown = active.provider === null || providers.some((p) => p.provider === active.provider);
  const modelKnown = active.model === null || available.some((m) => m.id === active.model);

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="provider-select">
        Provider
      </label>
      <select
        id="provider-select"
        className={SELECT_CLASS}
        value={active.provider ?? ""}
        onChange={(event) => void chat?.setProvider(event.target.value as ProviderId)}
      >
        {active.provider === null ? <option value="">Choose provider</option> : null}
        {!providerKnown && active.provider ? <option value={active.provider}>{PROVIDER_LABELS[active.provider]} (not connected)</option> : null}
        {providers.map((p) => (
          <option key={p.provider} value={p.provider}>
            {p.label}
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="model-select">
        Model
      </label>
      <select
        id="model-select"
        className={SELECT_CLASS}
        value={active.model ?? ""}
        disabled={active.provider === null}
        onChange={(event) => active.provider && void chat?.setModel(active.provider, event.target.value)}
      >
        {active.model === null ? <option value="">{available.length === 0 ? "No models available" : "Choose model"}</option> : null}
        {!modelKnown && active.model ? <option value={active.model}>{active.model} (not in current list)</option> : null}
        {available.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name === m.id ? m.id : `${m.name} (${m.id})`}
          </option>
        ))}
      </select>
      <Button variant="ghost" size="icon" className="size-8" disabled={busy} onClick={() => void chat?.refreshModels()} aria-label="Refresh model list" title="Refresh model list">
        <RefreshCw className={busy ? "animate-spin" : undefined} />
      </Button>
    </div>
  );
}
