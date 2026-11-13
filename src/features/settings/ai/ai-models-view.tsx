import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAvailability, formatCoding, formatFreeTier, formatTokens, isSelectable } from "@/lib/ai-format";
import type { AiBusy, AiNotice } from "@/hooks/use-ai-settings";
import { cn } from "@/lib/utils";
import type { AiDefaults, AiModel, AiSettingsView, ModelCatalog, ProviderId } from "@/types/ai";

export interface AiModelsViewProps {
  settings: AiSettingsView;
  catalogs: readonly ModelCatalog[];
  defaultDraft: AiDefaults;
  busy: AiBusy;
  notice: AiNotice | null;
  /** Provider filter for the table; null shows all. */
  filter: ProviderId | null;
  showUnusable: boolean;
  onFilter(provider: ProviderId | null): void;
  onShowUnusable(value: boolean): void;
  onDefaultProvider(provider: ProviderId | null): void;
  onDefaultModel(model: string | null): void;
  onPick(model: AiModel): void;
  onSave(): void;
  onRefresh(): void;
}

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm disabled:cursor-not-allowed disabled:opacity-50";

export function AiModelsView(props: AiModelsViewProps) {
  const { settings, catalogs, defaultDraft } = props;
  const configured = settings.providers.filter((p) => p.configured);

  if (configured.length === 0) {
    return (
      <Card>
        <CardContent className="space-y-2 p-5">
          <p className="text-sm font-medium">No provider is configured</p>
          <p className="text-sm text-muted-foreground">Add a Gemini or Groq API key in AI Providers to see which models are available.</p>
        </CardContent>
      </Card>
    );
  }

  const label = (id: ProviderId) => settings.providers.find((p) => p.provider === id)?.label ?? id;
  const catalogFor = (id: ProviderId) => catalogs.find((c) => c.provider === id);
  const draftModels = defaultDraft.provider ? (catalogFor(defaultDraft.provider)?.models ?? []).filter(isSelectable) : [];
  const rows = catalogs
    .filter((c) => props.filter === null || c.provider === props.filter)
    .flatMap((c) => c.models)
    .filter((m) => props.showUnusable || isSelectable(m));
  const hidden = catalogs.filter((c) => props.filter === null || c.provider === props.filter).flatMap((c) => c.models).length - rows.length;
  const unchanged = defaultDraft.provider === settings.defaults.provider && defaultDraft.model === settings.defaults.model;
  const draftListed = defaultDraft.model === null || draftModels.some((m) => m.id === defaultDraft.model);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Default model</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="default-provider" className="text-sm font-medium">
                Default provider
              </label>
              <select id="default-provider" className={selectClass} value={defaultDraft.provider ?? ""} onChange={(e) => props.onDefaultProvider((e.target.value || null) as ProviderId | null)}>
                <option value="">None</option>
                {configured.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label htmlFor="default-model" className="text-sm font-medium">
                Default model
              </label>
              <select id="default-model" className={selectClass} disabled={defaultDraft.provider === null} value={defaultDraft.model ?? ""} onChange={(e) => props.onDefaultModel(e.target.value || null)}>
                <option value="">{defaultDraft.provider === null ? "Choose a provider first" : "Choose a model"}</option>
                {defaultDraft.model !== null && !draftListed ? <option value={defaultDraft.model}>{defaultDraft.model} (not in the current list)</option> : null}
                {draftModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {settings.defaultModelListed === false ? (
            <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
              The saved default model is no longer in {label(settings.defaults.provider ?? "gemini")}&apos;s model list. It may have been renamed or retired; pick another model.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button disabled={props.busy !== null || unchanged || (defaultDraft.provider !== null && defaultDraft.model === null)} onClick={props.onSave}>
              {props.busy === "save-defaults" ? "Saving…" : "Save configuration"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {settings.defaults.provider && settings.defaults.model ? `Saved: ${label(settings.defaults.provider)} · ${settings.defaults.model}` : "Nothing saved yet."}
            </span>
          </div>
          {props.notice ? (
            <p role={props.notice.tone === "error" ? "alert" : "status"} className={props.notice.tone === "error" ? "text-sm text-destructive" : "text-sm text-emerald-600 dark:text-emerald-400"}>
              {props.notice.text}
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 pb-3">
          <CardTitle>Available models</CardTitle>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <input type="checkbox" checked={props.showUnusable} onChange={(e) => props.onShowUnusable(e.target.checked)} />
              Show models that can&apos;t chat
            </label>
            <label className="sr-only" htmlFor="model-filter">
              Filter by provider
            </label>
            <select id="model-filter" className={cn(selectClass, "h-8 w-auto text-xs")} value={props.filter ?? ""} onChange={(e) => props.onFilter((e.target.value || null) as ProviderId | null)}>
              <option value="">All providers</option>
              {configured.map((p) => (
                <option key={p.provider} value={p.provider}>
                  {p.label}
                </option>
              ))}
            </select>
            <Button variant="outline" size="sm" disabled={props.busy !== null} onClick={props.onRefresh}>
              {props.busy === "models" ? "Refreshing…" : "Refresh models"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {catalogs
            .filter((c) => c.error !== null)
            .map((c) => (
              <p key={c.provider} role="alert" className="text-sm text-destructive">
                {label(c.provider)}: {c.error!.message}
                {c.stale ? " Showing the last list that loaded." : ""}
              </p>
            ))}
          {catalogs.length === 0 ? <p className="text-sm text-muted-foreground">No model list loaded yet. Use Refresh models.</p> : null}
          {rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    {["Provider", "Model ID", "Name", "Context window", "Coding", "Free tier", "Status", ""].map((h) => (
                      <th key={h || "action"} scope="col" className="whitespace-nowrap py-2 pr-4 font-medium">
                        {h || <span className="sr-only">Select</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((m) => {
                    const chosen = defaultDraft.provider === m.provider && defaultDraft.model === m.id;
                    return (
                      <tr key={`${m.provider}/${m.id}`} aria-selected={chosen}>
                        <td className="py-2 pr-4">{label(m.provider)}</td>
                        <td className="py-2 pr-4 font-mono text-xs">{m.id}</td>
                        <td className="py-2 pr-4">{m.name}</td>
                        <td className="whitespace-nowrap py-2 pr-4 tabular-nums">{formatTokens(m.contextWindow)}</td>
                        <td className="py-2 pr-4">{formatCoding(m.coding)}</td>
                        <td className="py-2 pr-4">
                          <Badge variant="muted">{formatFreeTier(m.freeTier)}</Badge>
                        </td>
                        <td className="py-2 pr-4" title={m.availabilityNote ?? undefined}>
                          {formatAvailability(m)}
                          {m.availabilityNote ? <span className="text-xs text-muted-foreground"> (guessed from the name)</span> : null}
                        </td>
                        <td className="py-2">
                          {isSelectable(m) ? (
                            <Button variant={chosen ? "secondary" : "ghost"} size="sm" disabled={chosen} onClick={() => props.onPick(m)}>
                              {chosen ? "Selected" : "Use"}
                            </Button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : catalogs.length > 0 ? (
            <p className="text-sm text-muted-foreground">No chat-capable models to show.</p>
          ) : null}
          {hidden > 0 ? <p className="text-xs text-muted-foreground">{hidden} model(s) hidden because they can&apos;t generate chat text or are inactive.</p> : null}
          <p className="text-xs text-muted-foreground">
            The model list comes straight from each provider, so it changes as providers add and retire models. Neither provider&apos;s API says whether a model is on the free tier, so it is shown as &ldquo;Not verified&rdquo;; check the provider&apos;s rate-limit page. Free-tier eligibility is not the same as how much quota you have left. &ldquo;Code-focused&rdquo; is judged from the model name only.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
