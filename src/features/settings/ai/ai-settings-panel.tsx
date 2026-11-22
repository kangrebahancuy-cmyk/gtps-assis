"use client";

import { useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { AiModelsView } from "@/features/settings/ai/ai-models-view";
import { AiProvidersView } from "@/features/settings/ai/ai-providers-view";
import { useAiSettings, type UseAiSettings } from "@/hooks/use-ai-settings";
import type { ProviderId } from "@/types/ai";

function Unavailable({ state }: { state: UseAiSettings }) {
  if (state.loadState === "loading") return <p className="text-sm text-muted-foreground">Loading…</p>;
  return (
    <Card>
      <CardContent className="space-y-1 p-5">
        <p className="text-sm font-medium">{state.loadError?.kind === "backend_unavailable" ? "The backend is locked on this host" : state.loadState === "unreachable" ? "Can't reach the local backend" : "Couldn't load the AI settings"}</p>
        <p className="text-sm text-muted-foreground">{state.loadError?.message ?? "Make sure the app is running and reload this page."}</p>
      </CardContent>
    </Card>
  );
}

export function AiSettingsPanel({ section }: { section: "providers" | "models" }) {
  const state = useAiSettings();
  const [filter, setFilter] = useState<ProviderId | null>(null);
  const [showUnusable, setShowUnusable] = useState(false);

  if (state.loadState !== "ready" || state.settings === null) return <Unavailable state={state} />;
  const { settings } = state;

  if (section === "providers") {
    return (
      <AiProvidersView
        providers={settings.providers}
        keyDrafts={state.keyDrafts}
        tests={state.tests}
        busy={state.busy}
        notice={state.notice}
        now={Date.now()}
        onKeyChange={state.setKeyDraft}
        onTest={(provider, scope) => void state.testConnection(provider, scope)}
        onSave={() => void state.saveKeys()}
        onRemove={(provider) => {
          if (window.confirm("Remove the saved key for this provider from this computer?")) void state.remove(provider);
        }}
        onRemoveAll={() => {
          if (window.confirm("Remove all saved keys and the default model from this computer?")) void state.remove("all");
        }}
      />
    );
  }

  return (
    <AiModelsView
      settings={settings}
      catalogs={state.catalogs}
      defaultDraft={state.defaultDraft}
      busy={state.busy}
      notice={state.notice}
      filter={filter}
      showUnusable={showUnusable}
      onFilter={setFilter}
      onShowUnusable={setShowUnusable}
      onDefaultProvider={state.setDefaultProvider}
      onDefaultModel={state.setDefaultModel}
      onPick={(model) => {
        state.setDefaultProvider(model.provider);
        state.setDefaultModel(model.id);
      }}
      onSave={() => void state.saveDefaults()}
      onRefresh={() => void state.refreshModels()}
    />
  );
}
