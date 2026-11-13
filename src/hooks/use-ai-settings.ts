"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { errorHint } from "@/lib/ai-format";
import { aiClient, AiClientError } from "@/services/ai-client";
import { PROVIDER_IDS, type AiDefaults, type AiErrorInfo, type AiSettingsView, type ConnectionTestResult, type ModelCatalog, type ProviderId } from "@/types/ai";

export type AiBusy = null | "save-keys" | "save-defaults" | "models" | `test:${ProviderId}` | `remove:${ProviderId | "all"}`;

export interface AiNotice {
  tone: "success" | "error";
  text: string;
}

export interface UseAiSettings {
  /** loading: first request pending. unreachable: the local backend did not answer. */
  loadState: "loading" | "ready" | "unreachable" | "error";
  loadError: AiErrorInfo | null;
  settings: AiSettingsView | null;
  catalogs: ModelCatalog[];
  busy: AiBusy;
  notice: AiNotice | null;
  tests: Partial<Record<ProviderId, ConnectionTestResult>>;
  /** Text typed into the key fields. Held in memory only; cleared once saved. */
  keyDrafts: Record<ProviderId, string>;
  setKeyDraft(provider: ProviderId, value: string): void;
  defaultDraft: AiDefaults;
  setDefaultProvider(provider: ProviderId | null): void;
  setDefaultModel(model: string | null): void;
  saveKeys(): Promise<void>;
  saveDefaults(): Promise<void>;
  testConnection(provider: ProviderId, scope: "key" | "model"): Promise<void>;
  refreshModels(provider?: ProviderId): Promise<void>;
  remove(provider: ProviderId | "all"): Promise<void>;
}

const emptyDrafts = (): Record<ProviderId, string> => ({ gemini: "", groq: "" });

export const describeError = (error: unknown): string => {
  if (error instanceof AiClientError) {
    const hint = errorHint(error.info);
    return hint ? `${error.info.message} ${hint}` : error.info.message;
  }
  return "Something went wrong.";
};

/** State and actions behind the AI settings sections. Everything goes through the local backend. */
export function useAiSettings(): UseAiSettings {
  const [loadState, setLoadState] = useState<UseAiSettings["loadState"]>("loading");
  const [loadError, setLoadError] = useState<AiErrorInfo | null>(null);
  const [settings, setSettings] = useState<AiSettingsView | null>(null);
  const [catalogs, setCatalogs] = useState<ModelCatalog[]>([]);
  const [busy, setBusy] = useState<AiBusy>(null);
  const [notice, setNotice] = useState<AiNotice | null>(null);
  const [tests, setTests] = useState<Partial<Record<ProviderId, ConnectionTestResult>>>({});
  const [keyDrafts, setKeyDrafts] = useState(emptyDrafts);
  const [defaultDraft, setDefaultDraft] = useState<AiDefaults>({ provider: null, model: null });
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applySettings = useCallback((next: AiSettingsView) => {
    setSettings(next);
    setDefaultDraft(next.defaults);
  }, []);

  const loadCatalogs = useCallback(async (provider?: ProviderId, refresh = false) => {
    const next = await aiClient.getModels(provider, refresh);
    if (!mounted.current) return;
    // Merge: a single-provider reply replaces only that provider's catalog.
    setCatalogs((current) => (provider ? [...current.filter((c) => c.provider !== provider), ...next] : next).sort((a, b) => PROVIDER_IDS.indexOf(a.provider) - PROVIDER_IDS.indexOf(b.provider)));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const loaded = await aiClient.getSettings();
        if (!mounted.current) return;
        applySettings(loaded);
        setLoadState("ready");
        if (loaded.providers.some((p) => p.configured)) await loadCatalogs().catch(() => {});
      } catch (error) {
        if (!mounted.current) return;
        const info = error instanceof AiClientError ? error.info : null;
        setLoadError(info);
        setLoadState(info?.kind === "network" ? "unreachable" : "error");
      }
    })();
  }, [applySettings, loadCatalogs]);

  /** Runs an action with the busy flag, converting failures to a visible notice. */
  const run = useCallback(async (label: Exclude<AiBusy, null>, action: () => Promise<string | void>) => {
    setBusy(label);
    setNotice(null);
    try {
      const message = await action();
      if (mounted.current && message) setNotice({ tone: "success", text: message });
    } catch (error) {
      if (mounted.current) setNotice({ tone: "error", text: describeError(error) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, []);

  const saveKeys = useCallback(
    () =>
      run("save-keys", async () => {
        const keys: Partial<Record<ProviderId, string>> = {};
        for (const id of PROVIDER_IDS) if (keyDrafts[id].trim() !== "") keys[id] = keyDrafts[id].trim();
        if (Object.keys(keys).length === 0) return "No new key entered. Saved keys are unchanged.";
        applySettings(await aiClient.saveConfig({ keys }));
        setKeyDrafts(emptyDrafts());
        setTests((current) => {
          const next = { ...current };
          for (const id of Object.keys(keys) as ProviderId[]) delete next[id];
          return next;
        });
        await loadCatalogs().catch(() => {});
        return "Key saved on this computer.";
      }),
    [run, keyDrafts, applySettings, loadCatalogs],
  );

  const saveDefaults = useCallback(
    () =>
      run("save-defaults", async () => {
        if (defaultDraft.provider === null || defaultDraft.model === null) {
          applySettings(await aiClient.saveConfig({ defaults: null }));
          return "Default model cleared.";
        }
        applySettings(await aiClient.saveConfig({ defaults: { provider: defaultDraft.provider, model: defaultDraft.model } }));
        return "Default model saved.";
      }),
    [run, defaultDraft, applySettings],
  );

  const testConnection = useCallback(
    (provider: ProviderId, scope: "key" | "model") =>
      run(`test:${provider}`, async () => {
        const typed = keyDrafts[provider].trim();
        const model = scope === "model" && defaultDraft.provider === provider ? defaultDraft.model ?? undefined : undefined;
        const result = await aiClient.testConnection(provider, { scope, ...(typed ? { apiKey: typed } : {}), ...(model ? { model } : {}) });
        if (mounted.current) setTests((current) => ({ ...current, [provider]: result }));
        // Quota/limit information may have changed with this call.
        const fresh = await aiClient.getSettings().catch(() => null);
        if (fresh && mounted.current) setSettings(fresh);
      }),
    [run, keyDrafts, defaultDraft],
  );

  const refreshModels = useCallback(
    (provider?: ProviderId) =>
      run("models", async () => {
        const targets = provider ? [provider] : (settings?.providers.filter((p) => p.configured).map((p) => p.provider) ?? []);
        if (targets.length === 0) throw new AiClientError({ kind: "not_configured", message: "Add an API key first.", provider: null, status: null, retryable: false, retryAfterMs: null });
        for (const id of targets) await loadCatalogs(id, true);
        const fresh = await aiClient.getSettings().catch(() => null);
        if (fresh && mounted.current) setSettings(fresh);
        return "Model list refreshed.";
      }),
    [run, settings, loadCatalogs],
  );

  const remove = useCallback(
    (provider: ProviderId | "all") =>
      run(`remove:${provider}`, async () => {
        applySettings(await aiClient.removeConfig(provider));
        setCatalogs((current) => (provider === "all" ? [] : current.filter((c) => c.provider !== provider)));
        setTests((current) => (provider === "all" ? {} : { ...current, [provider]: undefined }));
        await loadCatalogs().catch(() => {});
        return provider === "all" ? "All saved configuration removed." : "Saved configuration removed for this provider.";
      }),
    [run, applySettings, loadCatalogs],
  );

  return {
    loadState,
    loadError,
    settings,
    catalogs,
    busy,
    notice,
    tests,
    keyDrafts,
    setKeyDraft: (provider, value) => setKeyDrafts((current) => ({ ...current, [provider]: value })),
    defaultDraft,
    setDefaultProvider: (provider) => setDefaultDraft({ provider, model: null }),
    setDefaultModel: (model) => setDefaultDraft((current) => ({ ...current, model })),
    saveKeys,
    saveDefaults,
    testConnection,
    refreshModels,
    remove,
  };
}
