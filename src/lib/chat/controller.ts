import { modeOf, type ChatMode } from "@/lib/chat/mode";
import { buildContext, deriveTitle } from "@/lib/chat/context";
import { buildExport, ImportError, parseImport } from "@/lib/chat/export";
import { newId } from "@/lib/chat/ids";
import { configuredProviders, selectableModels } from "@/lib/chat/models";
import type { ChatRepository, Conversation, ImportResult, MessageError, SearchHit, StoredMessage } from "@/lib/chat/types";
import { AiClientError, type AiClient } from "@/services/ai-client";
import { PROVIDER_IDS, isProviderId, type AiDefaults, type AiErrorInfo, type ChatStreamEvent, type ModelCatalog, type ProviderId, type ProviderStatus } from "@/types/ai";

/**
 * The chat engine. It owns the conversations, the messages of the open chat,
 * the streaming of replies and the saving to the repository. It has no React
 * in it: the UI subscribes to `getState()` and calls the methods below.
 */

export const MAX_INPUT_CHARS = 100_000;
const MAX_TITLE_CHARS = 120;
const META_ACTIVE = "activeId";
const META_TARGET = "lastTarget";
const META_DOCS = "docsSearch";
const META_MODEL = (provider: ProviderId) => `lastModel:${provider}`;

export interface ModelChoices {
  status: "idle" | "loading" | "ready" | "unreachable" | "error";
  error: string | null;
  providers: ProviderStatus[];
  catalogs: ModelCatalog[];
  defaults: AiDefaults;
}

export interface Notice {
  tone: "error" | "success" | "info";
  text: string;
}

export interface ChatState {
  ready: boolean;
  persistence: "indexeddb" | "memory";
  /** Why history is not being kept (IndexedDB unavailable), or the last saving problem. */
  persistenceNote: string | null;
  conversations: Conversation[];
  /** The open chat. It is a draft (not stored yet) until the first message is sent. */
  active: Conversation;
  isDraft: boolean;
  messages: StoredMessage[];
  /** Ids of conversations that are generating a reply right now. */
  generating: string[];
  models: ModelChoices;
  notice: Notice | null;
  /** Unsent text of the composer (not stored). */
  draftText: string;
  /** Search the indexed documentation before answering (remembered across reloads). */
  docsSearch: boolean;
  search: { query: string; hits: SearchHit[] | null; pending: boolean };
}

/** What the UI shows before the controller exists (server render, first paint). */
export const LOADING_STATE: ChatState = {
  ready: false,
  persistence: "indexeddb",
  persistenceNote: null,
  conversations: [],
  active: { id: "loading", title: "New chat", titleSource: "auto", createdAt: 0, updatedAt: 0, provider: null, model: null, messageCount: 0, metadata: {} },
  isDraft: true,
  messages: [],
  generating: [],
  models: { status: "idle", error: null, providers: [], catalogs: [], defaults: { provider: null, model: null } },
  notice: null,
  draftText: "",
  docsSearch: true,
  search: { query: "", hits: null, pending: false },
};

export interface ChatDeps {
  repository: ChatRepository;
  ai: Pick<AiClient, "getSettings" | "getModels" | "streamChat">;
  /** Set when IndexedDB could not be opened and a memory repository is used instead. */
  fallbackReason?: string | null;
  now?: () => number;
  /** How often a streaming reply is written to storage (ms). */
  persistThrottleMs?: number;
}

interface Generation {
  abort: AbortController;
  messageId: string;
  finished: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
}

const errorOf = (info: AiErrorInfo): MessageError => ({ kind: info.kind, message: info.message, retryAfterMs: info.retryAfterMs });
const describe = (error: unknown): string => (error instanceof Error ? error.message : "Unknown error");

export class ChatController {
  private state: ChatState;
  private readonly listeners = new Set<() => void>();
  private readonly repo: ChatRepository;
  private readonly ai: ChatDeps["ai"];
  private readonly now: () => number;
  private readonly throttle: number;
  private readonly cache = new Map<string, StoredMessage[]>();
  private readonly gens = new Map<string, Generation>();
  private readonly dropped = new Set<string>();
  private searchSeq = 0;
  private started: Promise<void> | null = null;
  private disposed = false;

  constructor(deps: ChatDeps) {
    this.repo = deps.repository;
    this.ai = deps.ai;
    this.now = deps.now ?? (() => Date.now());
    this.throttle = deps.persistThrottleMs ?? 400;
    this.state = {
      ready: false,
      persistence: deps.repository.kind,
      persistenceNote: deps.fallbackReason ? `Your chat history will not be kept after you reload: ${deps.fallbackReason}` : null,
      conversations: [],
      active: this.blankConversation(null),
      isDraft: true,
      messages: [],
      generating: [],
      models: { status: "idle", error: null, providers: [], catalogs: [], defaults: { provider: null, model: null } },
      notice: null,
      draftText: "",
      docsSearch: true,
      search: { query: "", hits: null, pending: false },
    };
  }

  // ---- store interface ---------------------------------------------------

  getState = (): ChatState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  private set(patch: Partial<ChatState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  // ---- start up ------------------------------------------------------------

  /** Loads the history and the model list. Safe to call more than once. */
  init(): Promise<void> {
    this.started ??= this.start();
    return this.started;
  }

  private async start(): Promise<void> {
    const modelsLoaded = this.loadModels(false);
    try {
      const conversations = await this.repo.listConversations();
      const activeId = await this.repo.getMeta(META_ACTIVE);
      if ((await this.repo.getMeta(META_DOCS)) === "off") this.set({ docsSearch: false });
      this.set({ conversations });
      const open = conversations.find((c) => c.id === activeId);
      if (open) await this.open(open);
    } catch (error) {
      this.set({ persistenceNote: `Could not read the saved chat history: ${describe(error)}` });
    }
    await modelsLoaded;
    if (this.state.isDraft && this.state.active.provider === null) this.set({ active: { ...this.state.active, ...(await this.chooseTarget()) } });
    this.set({ ready: true });
  }

  // ---- model choices ---------------------------------------------------------

  private async loadModels(refresh: boolean): Promise<void> {
    this.set({ models: { ...this.state.models, status: "loading", error: null } });
    try {
      const settings = await this.ai.getSettings();
      const catalogs = settings.providers.some((p) => p.configured) ? await this.ai.getModels(undefined, refresh) : [];
      this.set({ models: { status: "ready", error: null, providers: settings.providers, catalogs, defaults: settings.defaults } });
    } catch (error) {
      const unreachable = error instanceof AiClientError && error.info.kind === "network";
      this.set({ models: { ...this.state.models, status: unreachable ? "unreachable" : "error", error: describe(error) } });
    }
  }

  /** Reloads providers and models (bypassing the server's cache) and gives a draft chat a target if it had none. */
  async refreshModels(): Promise<void> {
    await this.loadModels(true);
    if (this.state.isDraft && this.state.active.provider === null) this.set({ active: { ...this.state.active, ...(await this.chooseTarget()) } });
  }

  /** Remembered choice, else the default from Settings, else the first available model. */
  private async chooseTarget(): Promise<{ provider: ProviderId | null; model: string | null }> {
    const { providers, catalogs, defaults } = this.state.models;
    const configured = configuredProviders(providers).map((p) => p.provider);
    const stillThere = (provider: ProviderId, model: string) => configured.includes(provider) && selectableModels(catalogs, provider).some((m) => m.id === model);

    try {
      const raw = await this.repo.getMeta(META_TARGET);
      const last = raw ? (JSON.parse(raw) as { provider?: unknown; model?: unknown }) : null;
      if (last && isProviderId(last.provider) && typeof last.model === "string" && stillThere(last.provider, last.model)) return { provider: last.provider, model: last.model };
    } catch {
      // a damaged preference is ignored
    }
    if (defaults.provider && defaults.model && stillThere(defaults.provider, defaults.model)) return { provider: defaults.provider, model: defaults.model };
    for (const provider of PROVIDER_IDS) {
      if (!configured.includes(provider)) continue;
      const first = selectableModels(catalogs, provider)[0];
      if (first) return { provider, model: first.id };
    }
    return { provider: null, model: null };
  }

  // ---- conversations -----------------------------------------------------------

  private blankConversation(target: { provider: ProviderId | null; model: string | null } | null, mode: ChatMode = "chat"): Conversation {
    const at = this.now?.() ?? Date.now();
    return { id: newId("chat"), title: mode === "generate" ? "New script" : "New chat", titleSource: "auto", createdAt: at, updatedAt: at, provider: target?.provider ?? null, model: target?.model ?? null, messageCount: 0, metadata: mode === "generate" ? { mode: "generate" } : {} };
  }

  /** Opens a new empty chat of the given mode (or keeps the current one if it is still empty). */
  async newChat(mode: ChatMode = "chat"): Promise<void> {
    if (this.state.isDraft) {
      // An empty draft simply takes the requested mode.
      if (modeOf(this.state.active) !== mode) this.set({ active: this.blankConversation(this.state.active.provider ? { provider: this.state.active.provider, model: this.state.active.model } : null, mode), notice: null });
      else this.set({ notice: null });
      return;
    }
    const target = await this.chooseTarget();
    this.set({ active: this.blankConversation(target, mode), isDraft: true, messages: [], notice: null });
    this.persistMeta(META_ACTIVE, null);
  }

  /**
   * Makes sure the open conversation is of this mode: the latest conversation of that mode is opened,
   * or an empty one is started. Used when a page (Chat, Script Generator) is opened.
   */
  async ensureMode(mode: ChatMode): Promise<void> {
    await this.init();
    if (modeOf(this.state.active) === mode) return;
    const latest = this.state.conversations.find((c) => modeOf(c) === mode);
    if (latest) await this.open(latest);
    else await this.newChat(mode);
  }

  async select(id: string): Promise<void> {
    if (id === this.state.active.id && !this.state.isDraft) return;
    const conversation = this.state.conversations.find((c) => c.id === id);
    if (!conversation) return;
    await this.open(conversation);
  }

  private async open(conversation: Conversation): Promise<void> {
    let messages = this.cache.get(conversation.id);
    if (!messages) {
      messages = await this.repo.getMessages(conversation.id);
      messages = await this.markInterrupted(conversation, messages);
    }
    this.evictIdle(conversation.id);
    this.cache.set(conversation.id, messages);
    this.set({ active: conversation, isDraft: false, messages, notice: null });
    this.persistMeta(META_ACTIVE, conversation.id);
  }

  /** A reply still marked "streaming" in storage belongs to a page that was closed mid-reply. */
  private async markInterrupted(conversation: Conversation, messages: StoredMessage[]): Promise<StoredMessage[]> {
    if (this.gens.has(conversation.id) || !messages.some((m) => m.status === "streaming")) return messages;
    const fixed = messages.map((m) => (m.status === "streaming" ? { ...m, status: "interrupted" as const } : m));
    await this.save(conversation, fixed.filter((m, i) => m !== messages[i]));
    return fixed;
  }

  private evictIdle(keep: string): void {
    for (const id of [...this.cache.keys()]) if (id !== keep && !this.gens.has(id)) this.cache.delete(id);
  }

  async rename(id: string, title: string): Promise<boolean> {
    const clean = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
    if (clean === "") {
      this.set({ notice: { tone: "error", text: "A chat title can't be empty." } });
      return false;
    }
    const current = this.state.conversations.find((c) => c.id === id);
    if (!current) return false;
    const next: Conversation = { ...current, title: clean, titleSource: "manual" };
    this.upsert(next);
    await this.save(next);
    return true;
  }

  async remove(id: string): Promise<void> {
    await this.drop(id);
    try {
      await this.repo.deleteConversation(id);
    } catch (error) {
      this.dropped.delete(id);
      this.set({ notice: { tone: "error", text: `Could not delete the chat: ${describe(error)}` } });
      return;
    }
    this.cache.delete(id);
    this.dropped.delete(id);
    this.set({ conversations: this.state.conversations.filter((c) => c.id !== id) });
    if (this.state.active.id === id) {
      const target = await this.chooseTarget();
      this.set({ active: this.blankConversation(target), isDraft: true, messages: [] });
      this.persistMeta(META_ACTIVE, null);
    }
  }

  async clearAll(): Promise<void> {
    for (const id of [...this.gens.keys()]) await this.drop(id);
    try {
      await this.repo.clearAll();
    } catch (error) {
      this.set({ notice: { tone: "error", text: `Could not clear the history: ${describe(error)}` } });
      return;
    }
    this.cache.clear();
    this.dropped.clear();
    const target = await this.chooseTarget();
    this.set({ conversations: [], active: this.blankConversation(target), isDraft: true, messages: [], search: { query: "", hits: null, pending: false }, notice: { tone: "success", text: "All chat history was deleted." } });
  }

  /** Stops a running reply for a conversation that is about to disappear, without saving anything for it. */
  private async drop(id: string): Promise<void> {
    const gen = this.gens.get(id);
    if (!gen) return;
    this.dropped.add(id);
    gen.abort.abort();
    await gen.finished;
  }

  // ---- model selection per conversation ------------------------------------------

  async setProvider(provider: ProviderId): Promise<void> {
    const { catalogs, defaults } = this.state.models;
    const models = selectableModels(catalogs, provider);
    const remembered = await this.repo.getMeta(META_MODEL(provider)).catch(() => null);
    const model = [remembered, defaults.provider === provider ? defaults.model : null, models[0]?.id ?? null].find((id) => id !== null && models.some((m) => m.id === id)) ?? null;
    await this.applyTarget(provider, model);
  }

  async setModel(provider: ProviderId, model: string): Promise<void> {
    await this.applyTarget(provider, model);
  }

  private async applyTarget(provider: ProviderId, model: string | null): Promise<void> {
    const next: Conversation = { ...this.state.active, provider, model };
    this.set({ active: next });
    if (!this.state.isDraft) {
      this.upsert(next, false);
      await this.save(next);
    }
    if (model !== null) {
      this.persistMeta(META_TARGET, JSON.stringify({ provider, model }));
      this.persistMeta(META_MODEL(provider), model);
    }
  }

  // ---- sending, streaming ---------------------------------------------------------

  setDraftText(text: string): void {
    this.set({ draftText: text });
  }

  /** Turns documentation search on or off for the next questions. */
  setDocsSearch(on: boolean): void {
    this.set({ docsSearch: on });
    this.persistMeta(META_DOCS, on ? "on" : "off");
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  isGenerating(id: string = this.state.active.id): boolean {
    return this.gens.has(id);
  }

  /** Sends a message and resolves when the reply has finished (or failed). Returns false if nothing was sent. */
  async send(text: string, options: { mode?: ChatMode } = {}): Promise<boolean> {
    const content = text.trim();
    const guard = this.cannotSend(content);
    if (guard) {
      this.set({ notice: { tone: "error", text: guard } });
      return false;
    }
    const base = this.state.active;
    const at = this.now();
    const user = this.makeMessage(base.id, this.state.messages.length, "user", content, "complete");
    // Only a request that differs from the conversation's mode is remembered on the message (so regenerating repeats it).
    if (options.mode && options.mode !== modeOf(base)) user.meta = { ...user.meta, requestMode: options.mode };
    const assistant = this.makeMessage(base.id, user.order + 1, "assistant", "", "streaming", { provider: base.provider, model: base.model });
    const conversation: Conversation = {
      ...base,
      title: this.state.messages.length === 0 && base.titleSource === "auto" ? deriveTitle(content) : base.title,
      messageCount: user.order + 2,
      updatedAt: at,
    };

    this.cache.set(conversation.id, [...this.state.messages, user, assistant]);
    this.upsert(conversation);
    this.set({ active: conversation, isDraft: false, messages: this.cache.get(conversation.id)!, draftText: "", notice: null });
    this.persistMeta(META_ACTIVE, conversation.id);
    if (conversation.provider && conversation.model) {
      this.persistMeta(META_TARGET, JSON.stringify({ provider: conversation.provider, model: conversation.model }));
      this.persistMeta(META_MODEL(conversation.provider), conversation.model);
    }
    // Saved before the request starts, so the question is kept even if the page closes mid-reply.
    await this.save(conversation, [user, assistant]);
    await this.generate(conversation.id, assistant.id);
    return true;
  }

  private cannotSend(content: string): string | null {
    if (!this.state.ready) return "The chat is still loading.";
    if (content === "") return "Type a message first.";
    if (content.length > MAX_INPUT_CHARS) return `That message is too long (limit ${MAX_INPUT_CHARS.toLocaleString("en-US")} characters).`;
    if (this.gens.has(this.state.active.id)) return "A reply is still being generated. Stop it first.";
    const { provider, model } = this.state.active;
    if (!provider || !model) return configuredProviders(this.state.models.providers).length === 0 ? "No AI provider is connected. Add an API key in Settings → AI Providers." : "Choose a provider and model first.";
    return null;
  }

  /** Stops the reply being generated for a conversation (the open one by default). Partial text is kept. */
  async stop(id: string = this.state.active.id): Promise<void> {
    const gen = this.gens.get(id);
    if (!gen) return;
    gen.abort.abort();
    await gen.finished;
  }

  /** Replaces the last reply with a new one, using the model currently selected for this chat. */
  async regenerate(): Promise<boolean> {
    const { active, messages } = this.state;
    if (this.gens.has(active.id)) return false;
    const last = messages[messages.length - 1];
    if (!last) return false;
    const guard = this.cannotSend("x");
    if (guard) {
      this.set({ notice: { tone: "error", text: guard } });
      return false;
    }
    const keep = last.role === "assistant" ? messages.slice(0, -1) : messages;
    const assistant = this.makeMessage(active.id, keep.length, "assistant", "", "streaming", { provider: active.provider, model: active.model });
    if (last.role === "assistant") assistant.id = last.id; // same message, new text
    await this.restart(keep, assistant, []);
    return true;
  }

  /** Changes a user message, removes everything after it and generates a new reply. */
  async editMessage(messageId: string, text: string): Promise<boolean> {
    const content = text.trim();
    const { active, messages } = this.state;
    const index = messages.findIndex((m) => m.id === messageId && m.role === "user");
    if (index === -1) return false;
    if (this.gens.has(active.id)) {
      this.set({ notice: { tone: "error", text: "A reply is still being generated. Stop it first." } });
      return false;
    }
    const guard = this.cannotSend(content);
    if (guard) {
      this.set({ notice: { tone: "error", text: guard } });
      return false;
    }
    const original = messages[index]!;
    const at = this.now();
    const edited: StoredMessage = { ...original, content, updatedAt: at, status: "complete", meta: { ...original.meta, edited: original.content !== content ? true : original.meta.edited } };
    const removed = messages.slice(index + 1).map((m) => m.id);
    const keep = [...messages.slice(0, index), edited];
    const assistant = this.makeMessage(active.id, keep.length, "assistant", "", "streaming", { provider: active.provider, model: active.model });
    await this.restart(keep, assistant, removed, [edited]);
    return true;
  }

  private async restart(keep: StoredMessage[], assistant: StoredMessage, removedIds: string[], changed: StoredMessage[] = []): Promise<void> {
    const base = this.state.active;
    const first = keep[0];
    const conversation: Conversation = {
      ...base,
      title: base.titleSource === "auto" && first?.role === "user" ? deriveTitle(first.content) : base.title,
      messageCount: keep.length + 1,
      updatedAt: this.now(),
    };
    const list = [...keep, assistant];
    this.cache.set(conversation.id, list);
    this.upsert(conversation);
    this.set({ active: conversation, messages: list, notice: null });
    await this.save(conversation, [...changed, assistant], removedIds);
    await this.generate(conversation.id, assistant.id);
  }

  private makeMessage(conversationId: string, order: number, role: "user" | "assistant", content: string, status: StoredMessage["status"], who: { provider: ProviderId | null; model: string | null } = { provider: null, model: null }): StoredMessage {
    const at = this.now();
    return { id: newId("msg"), conversationId, order, role, content, createdAt: at, updatedAt: at, status, provider: who.provider, model: who.model, meta: {} };
  }

  private generate(conversationId: string, messageId: string): Promise<void> {
    const abort = new AbortController();
    const gen: Generation = { abort, messageId, timer: null, finished: Promise.resolve() };
    this.gens.set(conversationId, gen);
    this.set({ generating: [...this.gens.keys()] });
    gen.finished = this.run(conversationId, messageId, gen).finally(() => this.endGeneration(conversationId, gen));
    return gen.finished;
  }

  /** Marks a generation as over, so the chat can be used again at once (the last save may still be running). */
  private endGeneration(conversationId: string, gen: Generation): void {
    if (this.gens.get(conversationId) !== gen) return;
    if (gen.timer) clearTimeout(gen.timer);
    this.gens.delete(conversationId);
    this.set({ generating: [...this.gens.keys()] });
    if (conversationId !== this.state.active.id) this.evictIdle(this.state.active.id);
  }

  private async run(conversationId: string, messageId: string, gen: Generation): Promise<void> {
    const list = this.cache.get(conversationId) ?? [];
    const target = list.find((m) => m.id === messageId);
    const conversation = this.state.conversations.find((c) => c.id === conversationId);
    if (!target || !conversation || !conversation.provider || !conversation.model) return;
    const history = list.filter((m) => m.order < target.order);

    const finish = (patch: Partial<StoredMessage>) => this.patch(conversationId, messageId, patch);
    try {
      // With documentation search on, the backend searches the index and writes the system prompt itself.
      // The message that is answered decides the mode: a script action may differ from the conversation's mode.
      const asked = [...history].reverse().find((m) => m.role === "user");
      const generating = (asked?.meta.requestMode ?? modeOf(conversation)) === "generate";
      // The generator always searches the documentation; plain chat follows the switch.
      const docs = generating || this.state.docsSearch;
      const request = {
        provider: conversation.provider,
        model: conversation.model,
        messages: buildContext(history, docs ? null : undefined),
        ...(generating ? { mode: "generate" as const } : docs ? { docs: true } : {}),
      };
      for await (const event of this.ai.streamChat(request, gen.abort.signal)) {
        this.apply(conversationId, messageId, event, gen);
      }
    } catch (error) {
      if (gen.abort.signal.aborted || (error instanceof AiClientError && error.info.kind === "cancelled")) finish({ status: "stopped" });
      else if (error instanceof AiClientError) finish({ status: "error", meta: { ...this.current(conversationId, messageId)?.meta, error: errorOf(error.info) } });
      else finish({ status: "error", meta: { ...this.current(conversationId, messageId)?.meta, error: { kind: "unknown", message: "Something went wrong while generating the reply.", retryAfterMs: null } } });
    }
    if (this.current(conversationId, messageId)?.status === "streaming") finish({ status: gen.abort.signal.aborted ? "stopped" : "complete" });

    if (this.dropped.has(conversationId)) return;
    const message = this.current(conversationId, messageId);
    const stored = this.state.conversations.find((c) => c.id === conversationId);
    if (message && stored) {
      const updated: Conversation = { ...stored, updatedAt: this.now(), messageCount: this.cache.get(conversationId)?.length ?? stored.messageCount };
      this.upsert(updated, true, conversationId);
      const saving = this.save(updated, [message]); // the write is issued now, so it is ordered before any later send
      this.endGeneration(conversationId, gen);
      await saving;
    }
  }

  private apply(conversationId: string, messageId: string, event: ChatStreamEvent, gen: Generation): void {
    const message = this.current(conversationId, messageId);
    if (!message) return;
    switch (event.type) {
      case "start":
        this.patch(conversationId, messageId, { provider: event.provider, model: event.model });
        break;
      case "context":
        this.patch(conversationId, messageId, { meta: { ...message.meta, docs: event.context } });
        break;
      case "script_check":
        this.patch(conversationId, messageId, { meta: { ...message.meta, check: event.check } });
        break;
      case "delta":
        this.patch(conversationId, messageId, { content: message.content + event.text });
        this.schedulePersist(conversationId, messageId, gen);
        break;
      case "usage":
        this.patch(conversationId, messageId, { meta: { ...message.meta, usage: { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens } } });
        break;
      case "done":
        if (event.finishReason === "blocked") {
          this.patch(conversationId, messageId, { status: "error", meta: { ...message.meta, finishReason: "blocked", error: { kind: "content_blocked", message: "The provider blocked this reply.", retryAfterMs: null } } });
        } else {
          this.patch(conversationId, messageId, { status: "complete", meta: { ...message.meta, finishReason: event.finishReason } });
        }
        break;
      case "error":
        this.patch(conversationId, messageId, { status: "error", meta: { ...message.meta, error: errorOf(event.error) } });
        break;
    }
  }

  // ---- helpers for message state ----------------------------------------------------

  private current(conversationId: string, messageId: string): StoredMessage | undefined {
    return this.cache.get(conversationId)?.find((m) => m.id === messageId);
  }

  private patch(conversationId: string, messageId: string, patch: Partial<StoredMessage>): void {
    const list = this.cache.get(conversationId);
    if (!list) return;
    const next = list.map((m) => (m.id === messageId ? { ...m, ...patch, updatedAt: this.now() } : m));
    this.cache.set(conversationId, next);
    if (this.state.active.id === conversationId) this.set({ messages: next });
  }

  private schedulePersist(conversationId: string, messageId: string, gen: Generation): void {
    if (gen.timer || this.dropped.has(conversationId)) return;
    gen.timer = setTimeout(() => {
      gen.timer = null;
      const message = this.current(conversationId, messageId);
      const conversation = this.state.conversations.find((c) => c.id === conversationId);
      if (message && conversation && !this.dropped.has(conversationId)) void this.save(conversation, [message]);
    }, this.throttle);
  }

  /** Puts a conversation into the history list (newest activity first). */
  private upsert(conversation: Conversation, resort = true, id: string = conversation.id): void {
    const rest = this.state.conversations.filter((c) => c.id !== id);
    const list = resort ? [conversation, ...rest].sort((a, b) => b.updatedAt - a.updatedAt) : this.state.conversations.some((c) => c.id === id) ? this.state.conversations.map((c) => (c.id === id ? conversation : c)) : [conversation, ...rest];
    this.set({ conversations: list, ...(this.state.active.id === id ? { active: conversation } : {}) });
  }

  private async save(conversation: Conversation, put: StoredMessage[] = [], removeMessageIds: string[] = []): Promise<void> {
    try {
      await this.repo.commit({ conversation, put, removeMessageIds });
      if (this.state.persistenceNote?.startsWith("Could not save")) this.set({ persistenceNote: null });
    } catch (error) {
      this.set({ persistenceNote: `Could not save to the local history: ${describe(error)}. The chat still works, but may be lost on reload.` });
    }
  }

  private persistMeta(key: string, value: string | null): void {
    void this.repo.setMeta(key, value).catch(() => {});
  }

  // ---- search, export, import -----------------------------------------------------------

  async search(query: string): Promise<void> {
    const seq = ++this.searchSeq;
    const q = query.trim();
    if (q === "") {
      this.set({ search: { query, hits: null, pending: false } });
      return;
    }
    this.set({ search: { query, hits: this.state.search.hits, pending: true } });
    try {
      const hits = await this.repo.search(q);
      if (seq === this.searchSeq) this.set({ search: { query, hits, pending: false } });
    } catch (error) {
      if (seq === this.searchSeq) this.set({ search: { query, hits: [], pending: false }, notice: { tone: "error", text: `Search failed: ${describe(error)}` } });
    }
  }

  /** The whole history as JSON text, ready to download. */
  async exportJson(): Promise<{ filename: string; text: string; conversations: number }> {
    const file = buildExport(await this.repo.snapshot());
    return { filename: `gtps-assistant-chats-${file.exportedAt.slice(0, 10)}.json`, text: JSON.stringify(file, null, 2), conversations: file.conversations.length };
  }

  /** Adds the conversations from an exported file; existing ones are left alone. Returns null (with a notice) if the file is unusable. */
  async importJson(text: string): Promise<ImportResult | null> {
    try {
      const result = await this.repo.importConversations(parseImport(text));
      const conversations = await this.repo.listConversations();
      this.set({
        conversations,
        notice: { tone: "success", text: `Imported ${result.conversations} chat(s) with ${result.messages} message(s).${result.skipped > 0 ? ` ${result.skipped} already existed and were skipped.` : ""}` },
      });
      return result;
    } catch (error) {
      this.set({ notice: { tone: "error", text: error instanceof ImportError ? `Import failed: ${error.message}` : `Import failed: ${describe(error)}` } });
      return null;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const gen of this.gens.values()) {
      gen.abort.abort();
      if (gen.timer) clearTimeout(gen.timer);
    }
    this.listeners.clear();
    this.repo.close();
  }
}
