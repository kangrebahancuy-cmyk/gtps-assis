import { AiConfigStore } from "@/server/ai/config-store";
import { AiError, toErrorInfo } from "@/server/ai/errors";
import { defaultSleep, resetDelayMs, type Sleep } from "@/server/ai/http";
import type { AiProvider, ProviderContext } from "@/server/ai/provider";
import { createGeminiProvider } from "@/server/ai/providers/gemini";
import { createGroqProvider } from "@/server/ai/providers/groq";
import { validateApiKey, validateModelId } from "@/server/ai/validate";
import {
  PROVIDER_IDS,
  type AiDefaults,
  type AiModel,
  type AiSettingsView,
  type ChatRequest,
  type ChatStreamEvent,
  type ConnectionTestResult,
  type FinishReason,
  type ModelCatalog,
  type ProviderId,
  type ProviderStatus,
  type RateLimitSnapshot,
} from "@/types/ai";

export type ProviderMap = Record<ProviderId, AiProvider>;

export function createProviders(): ProviderMap {
  return { gemini: createGeminiProvider(), groq: createGroqProvider() };
}

export interface AiServiceOptions {
  store: AiConfigStore;
  providers?: ProviderMap;
  fetch?: typeof fetch;
  sleep?: Sleep;
  now?: () => number;
  /** How long a fetched model list is reused before it is refreshed. */
  modelCacheTtlMs?: number;
  /** After a rate-limit response, chat requests to that provider are refused locally for this long (capped). */
  maxCooldownMs?: number;
  /** Cooldown used when the provider did not say how long to wait. */
  defaultCooldownMs?: number;
  timeoutMs?: number;
  streamIdleMs?: number;
  maxRetries?: number;
  maxRetryWaitMs?: number;
  retryBackoffMs?: number;
}

interface CatalogEntry {
  models: AiModel[];
  fetchedAt: number;
  keyFingerprint: string;
}

const TEST_PROMPT = "Reply with the single word: ok";

/** Cheap, non-reversible id so a cached model list is dropped when the key changes. */
function fingerprint(key: string): string {
  let hash = 5381;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  return `${key.length}:${hash}`;
}

/**
 * The single entry point the chat UI (and every other feature) uses for AI.
 * Callers pass provider-neutral requests and get provider-neutral events;
 * which provider answers is a configuration detail.
 */
export class AiService {
  private readonly store: AiConfigStore;
  private readonly providers: ProviderMap;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly options: AiServiceOptions;
  private readonly catalogs = new Map<ProviderId, CatalogEntry>();
  private readonly cooldowns = new Map<ProviderId, number>();
  private readonly rateLimits = new Map<ProviderId, RateLimitSnapshot>();

  constructor(options: AiServiceOptions) {
    this.options = options;
    this.store = options.store;
    this.providers = options.providers ?? createProviders();
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  // ---- settings -------------------------------------------------------------

  getSettings(): AiSettingsView {
    const defaults = this.store.getDefaults();
    const providers: ProviderStatus[] = PROVIDER_IDS.map((id) => {
      const provider = this.providers[id];
      const resolved = this.store.resolveKey(id);
      const catalog = this.catalogs.get(id);
      const until = this.cooldowns.get(id);
      return {
        provider: id,
        label: provider.label,
        configured: resolved !== null,
        keySource: resolved?.source ?? null,
        keyHint: resolved ? `…${resolved.key.slice(-4)}` : null,
        cooldownUntil: until && until > this.now() ? new Date(until).toISOString() : null,
        rateLimit: this.rateLimits.get(id) ?? null,
        modelsFetchedAt: catalog ? new Date(catalog.fetchedAt).toISOString() : null,
        modelCount: catalog ? catalog.models.length : null,
        docsUrl: provider.docsUrl,
        limitsUrl: provider.limitsUrl,
        quotaNote: provider.quotaNote,
      };
    });
    const catalog = defaults.provider ? this.catalogs.get(defaults.provider) : undefined;
    return {
      providers,
      defaults,
      defaultModelListed: catalog && defaults.model ? catalog.models.some((m) => m.id === defaults.model) : null,
    };
  }

  /** Saves keys (each validated) and/or the defaults. Nothing is saved if any part is invalid. */
  async saveConfig(input: { keys?: Partial<Record<ProviderId, string>>; defaults?: AiDefaults | null }): Promise<AiSettingsView> {
    const keys = new Map<ProviderId, string>();
    for (const [id, key] of Object.entries(input.keys ?? {})) keys.set(id as ProviderId, validateApiKey(key));

    let defaults: AiDefaults | undefined;
    let verifiedModels: { provider: ProviderId; models: AiModel[]; key: string } | null = null;

    if (input.defaults === null) defaults = { provider: null, model: null };
    else if (input.defaults) {
      const { provider, model } = input.defaults;
      if (!provider || !model) throw new AiError("invalid_input", "Choose both a provider and a model, or clear the default.");
      validateModelId(model);
      const key = keys.get(provider) ?? this.store.resolveKey(provider)?.key;
      if (!key) throw new AiError("not_configured", `${this.providers[provider].label} has no API key yet.`, { provider });

      // The model must be in the provider's current list and usable for chat. Checked with the key
      // that is about to be saved, before anything is written.
      const cached = this.catalogs.get(provider);
      const models =
        cached && cached.keyFingerprint === fingerprint(key) && this.now() - cached.fetchedAt < (this.options.modelCacheTtlMs ?? 10 * 60_000)
          ? cached.models
          : await this.providers[provider].listModels(this.context(provider, key));
      const found = models.find((m) => m.id === model);
      if (!found) {
        throw new AiError("invalid_input", `"${model}" is not in ${this.providers[provider].label}'s model list. Refresh the models and pick one from the list.`, { provider });
      }
      if (found.availability !== "available") {
        throw new AiError("invalid_input", `"${model}" cannot be used for chat${found.availabilityNote ? `: ${found.availabilityNote}` : "."}`, { provider });
      }
      defaults = { provider, model };
      verifiedModels = { provider, models, key };
    }

    for (const [id, key] of keys) {
      this.store.setKey(id, key);
      this.catalogs.delete(id);
      this.cooldowns.delete(id);
      this.rateLimits.delete(id);
    }
    if (verifiedModels) {
      this.catalogs.set(verifiedModels.provider, { models: verifiedModels.models, fetchedAt: this.now(), keyFingerprint: fingerprint(verifiedModels.key) });
    }
    if (defaults) this.store.setDefaults(defaults);
    return this.getSettings();
  }

  /** Removes the saved key of one provider, or of all. An environment key is not touched. */
  removeConfig(target: ProviderId | "all"): AiSettingsView {
    for (const id of target === "all" ? PROVIDER_IDS : [target]) {
      this.store.removeKey(id);
      this.catalogs.delete(id);
      this.cooldowns.delete(id);
      this.rateLimits.delete(id);
    }
    return this.getSettings();
  }

  // ---- plumbing -------------------------------------------------------------

  private requireKey(provider: ProviderId): string {
    const resolved = this.store.resolveKey(provider);
    if (!resolved) {
      throw new AiError("not_configured", `${this.providers[provider].label} has no API key. Add one in Settings → AI Providers.`, { provider });
    }
    return resolved.key;
  }

  private context(provider: ProviderId, apiKey: string, signal?: AbortSignal): ProviderContext {
    return {
      apiKey,
      fetch: this.fetchImpl,
      sleep: this.sleep,
      signal,
      timeoutMs: this.options.timeoutMs,
      streamIdleMs: this.options.streamIdleMs,
      maxRetries: this.options.maxRetries,
      maxRetryWaitMs: this.options.maxRetryWaitMs,
      retryBackoffMs: this.options.retryBackoffMs,
      onRateLimit: (snapshot) => this.rateLimits.set(provider, snapshot),
    };
  }

  private checkCooldown(provider: ProviderId): void {
    const until = this.cooldowns.get(provider);
    if (until === undefined) return;
    const remaining = until - this.now();
    if (remaining <= 0) {
      this.cooldowns.delete(provider);
      return;
    }
    throw new AiError(
      "rate_limited",
      `${this.providers[provider].label} asked us to slow down. Requests are paused locally for about ${Math.ceil(remaining / 1000)} s so the limit can reset.`,
      { provider, retryable: true, retryAfterMs: remaining },
    );
  }

  private noteFailure(provider: ProviderId, error: unknown): void {
    if (!(error instanceof AiError) || error.kind !== "rate_limited") return;
    const announced = error.retryAfterMs ?? resetDelayMs(this.rateLimits.get(provider) ?? null);
    const wait = Math.min(announced ?? this.options.defaultCooldownMs ?? 5_000, this.options.maxCooldownMs ?? 15 * 60_000);
    this.cooldowns.set(provider, this.now() + wait);
  }

  // ---- models ---------------------------------------------------------------

  /** The provider's model list: cached for a while; `refresh` always asks again. If the refresh fails the older list is returned marked stale. */
  async listModels(provider: ProviderId, options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelCatalog> {
    const key = this.requireKey(provider);
    const cached = this.catalogs.get(provider);
    const ttl = this.options.modelCacheTtlMs ?? 10 * 60_000;
    const usable = cached && cached.keyFingerprint === fingerprint(key);

    if (usable && !options.refresh && this.now() - cached.fetchedAt < ttl) {
      return { provider, models: cached.models, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: false, error: null };
    }
    try {
      if (!options.refresh) this.checkCooldown(provider);
      const models = await this.providers[provider].listModels(this.context(provider, key, options.signal));
      this.catalogs.set(provider, { models, fetchedAt: this.now(), keyFingerprint: fingerprint(key) });
      return { provider, models, fetchedAt: new Date(this.now()).toISOString(), stale: false, error: null };
    } catch (error) {
      this.noteFailure(provider, error);
      if (usable) {
        return { provider, models: cached.models, fetchedAt: new Date(cached.fetchedAt).toISOString(), stale: true, error: toErrorInfo(error, provider) };
      }
      throw error;
    }
  }

  /** Model lists of every configured provider. A provider that fails is reported with its error and no models. */
  async listAllModels(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<ModelCatalog[]> {
    const configured = PROVIDER_IDS.filter((id) => this.store.resolveKey(id) !== null);
    return Promise.all(
      configured.map(async (id): Promise<ModelCatalog> => {
        try {
          return await this.listModels(id, options);
        } catch (error) {
          return { provider: id, models: [], fetchedAt: new Date(this.now()).toISOString(), stale: false, error: toErrorInfo(error, id) };
        }
      }),
    );
  }

  // ---- connection test ---------------------------------------------------------

  /**
   * Checks a key (a candidate that is not saved, or the configured one) by
   * listing models; with scope "model" it also runs a tiny generation. Never throws:
   * failures come back in `error`. Tests ignore the local cooldown (the user asked).
   */
  async testConnection(
    provider: ProviderId,
    options: { apiKey?: string; scope?: "key" | "model"; model?: string; signal?: AbortSignal } = {},
  ): Promise<ConnectionTestResult> {
    const scope = options.scope ?? "key";
    const started = this.now();
    const result: ConnectionTestResult = { provider, scope, ok: false, latencyMs: null, modelCount: null, testedModel: null, error: null };
    let apiKey = "";
    try {
      apiKey = options.apiKey !== undefined ? validateApiKey(options.apiKey) : this.requireKey(provider);
      const candidate = options.apiKey !== undefined;
      const models = await this.providers[provider].listModels(this.context(provider, apiKey, options.signal));
      result.modelCount = models.length;
      if (!candidate) this.catalogs.set(provider, { models, fetchedAt: this.now(), keyFingerprint: fingerprint(apiKey) });

      if (scope === "model") {
        const model =
          options.model ??
          (this.store.getDefaults().provider === provider ? this.store.getDefaults().model : null) ??
          models.find((m) => m.availability === "available")?.id;
        if (!model) throw new AiError("not_configured", "No chat-capable model was found to test.", { provider });
        validateModelId(model);
        result.testedModel = model;
        for await (const event of this.providers[provider].streamChat(this.context(provider, apiKey, options.signal), {
          model,
          messages: [{ role: "user", content: TEST_PROMPT }],
          maxOutputTokens: 64,
        })) {
          void event; // consume the stream; reaching its end without an error is the success criterion
        }
      }
      result.ok = true;
    } catch (error) {
      this.noteFailure(provider, error);
      result.error = toErrorInfo(error, provider);
    }
    result.latencyMs = this.now() - started;
    return result;
  }

  // ---- chat -------------------------------------------------------------------

  /** Works out which provider/model a request will use: explicit values first, then the saved defaults. */
  resolveTarget(request: Pick<ChatRequest, "provider" | "model">): { provider: ProviderId; model: string } {
    const defaults = this.store.getDefaults();
    const provider = request.provider ?? defaults.provider;
    if (!provider) throw new AiError("not_configured", "No AI provider is selected. Choose a default provider in Settings → AI Providers.");
    const model = request.model ?? (defaults.provider === provider ? defaults.model : null);
    if (!model) throw new AiError("not_configured", `No model is selected for ${this.providers[provider].label}. Choose one in Settings → Models.`, { provider });
    return { provider, model };
  }

  /**
   * Streams a reply from whichever provider the request resolves to, as
   * provider-neutral events. Throws AiError on failure (before or during the stream).
   */
  async *streamChat(request: ChatRequest, signal?: AbortSignal): AsyncGenerator<ChatStreamEvent> {
    const { provider, model } = this.resolveTarget(request);
    const key = this.requireKey(provider);
    this.checkCooldown(provider);

    yield { type: "start", provider, model };
    try {
      yield* this.providers[provider].streamChat(this.context(provider, key, signal), {
        model,
        messages: request.messages,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
      });
    } catch (error) {
      this.noteFailure(provider, error);
      throw error;
    }
  }

  /** Convenience for non-streaming features: runs a chat and returns the whole reply. */
  async generateText(request: ChatRequest, signal?: AbortSignal): Promise<{ provider: ProviderId; model: string; text: string; finishReason: FinishReason }> {
    let text = "";
    let finishReason: FinishReason = "other";
    let provider: ProviderId | null = null;
    let model = "";
    for await (const event of this.streamChat(request, signal)) {
      if (event.type === "start") ({ provider, model } = event);
      else if (event.type === "delta") text += event.text;
      else if (event.type === "done") finishReason = event.finishReason;
    }
    return { provider: provider as ProviderId, model, text, finishReason };
  }
}
