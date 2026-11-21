"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useChat } from "@/features/chat/chat-provider";
import { ChatHistoryPanel } from "@/features/settings/chat-history-panel";
import { useAiSettings } from "@/hooks/use-ai-settings";
import { isSelectable } from "@/lib/ai-format";
import { setPreferences, usePreferences } from "@/store/preferences-store";
import type { ProviderId } from "@/types/ai";

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50";

/** The provider and model a new chat starts with. The same value as in Settings → Models (one stored default). */
function DefaultModelCard() {
  const ai = useAiSettings();
  const { chat } = useChat();
  const { settings, defaultDraft } = ai;

  // New chats read the default when the chat list loads; refresh it as soon as it changes.
  const savedKey = settings ? `${settings.defaults.provider}/${settings.defaults.model}` : "";
  useEffect(() => {
    if (savedKey) void chat?.refreshModels();
  }, [savedKey, chat]);

  if (ai.loadState === "loading") return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (ai.loadState !== "ready" || !settings) {
    return <Card><CardContent className="p-5 text-sm text-muted-foreground">{ai.loadError?.message ?? "The AI settings could not be loaded."}</CardContent></Card>;
  }
  const configured = settings.providers.filter((p) => p.configured);
  const models = defaultDraft.provider ? (ai.catalogs.find((c) => c.provider === defaultDraft.provider)?.models ?? []).filter(isSelectable) : [];
  const unchanged = defaultDraft.provider === settings.defaults.provider && defaultDraft.model === settings.defaults.model;

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <div>
          <p className="text-sm font-medium">Default provider and model</p>
          <p className="text-sm text-muted-foreground">New chats start with this model. You can still change the model inside any chat.</p>
        </div>
        {configured.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="chat-no-provider">No provider is configured yet. Add a Gemini or Groq API key under AI Providers first.</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="chat-default-provider" className="text-sm font-medium">Default provider</label>
                <select id="chat-default-provider" className={selectClass} value={defaultDraft.provider ?? ""} onChange={(e) => ai.setDefaultProvider((e.target.value || null) as ProviderId | null)}>
                  <option value="">None</option>
                  {configured.map((p) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="chat-default-model" className="text-sm font-medium">Default model</label>
                <select id="chat-default-model" className={selectClass} disabled={defaultDraft.provider === null} value={defaultDraft.model ?? ""} onChange={(e) => ai.setDefaultModel(e.target.value || null)}>
                  <option value="">{defaultDraft.provider === null ? "Choose a provider first" : "Choose a model"}</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name || m.id}</option>)}
                </select>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={unchanged || ai.busy !== null} onClick={() => void ai.saveDefaults()}>Save default</Button>
              <Button size="sm" variant="outline" disabled={ai.busy !== null} onClick={() => void ai.refreshModels()}>Refresh model list</Button>
            </div>
            {ai.notice ? <p role={ai.notice.tone === "error" ? "alert" : "status"} className={ai.notice.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>{ai.notice.text}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PrefSwitch({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p id={`${id}-label`} className="text-sm font-medium">{label}</p>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
      <Switch id={id} aria-labelledby={`${id}-label`} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function MarkdownCard() {
  const prefs = usePreferences();
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <p className="text-sm font-medium">Reply display</p>
        <PrefSwitch id="pref-markdown" label="Render Markdown" hint="Show replies with headings, lists, tables and code blocks. Off shows the raw text." checked={prefs.renderMarkdown} onChange={(renderMarkdown) => setPreferences({ renderMarkdown })} />
        <PrefSwitch id="pref-highlight" label="Highlight Lua code" hint="Colour keywords, strings and comments in Lua code blocks." checked={prefs.highlightCode} onChange={(highlightCode) => setPreferences({ highlightCode })} />
        <PrefSwitch id="pref-wrap" label="Wrap long code lines" hint="Wrap instead of scrolling sideways inside code blocks." checked={prefs.wrapCode} onChange={(wrapCode) => setPreferences({ wrapCode })} />
      </CardContent>
    </Card>
  );
}

export function ChatSettingsPanel() {
  return (
    <div className="space-y-4">
      <DefaultModelCard />
      <MarkdownCard />
      <ChatHistoryPanel />
    </div>
  );
}
