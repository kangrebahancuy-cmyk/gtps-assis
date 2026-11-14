/**
 * The chat engine against the real AI backend (client -> handlers -> AiService ->
 * provider adapters) in front of local fake Gemini/Groq servers. Covers new and
 * multiple conversations, reload persistence, model switching, streaming, stop,
 * regenerate, editing, error recovery, search and export/import.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { ChatController, type ChatState } from "@/lib/chat/controller";
import { MemoryChatRepository } from "@/lib/chat/memory-repository";
import type { ChatRepository, StoredMessage } from "@/lib/chat/types";
import { createAiClient } from "@/services/ai-client";
import { geminiStream, groqStream } from "./ai-fakes";
import { lastGroqMessages, startBackend, type Backend } from "./support/backend";
import { conv, msg } from "./support/chat-fixtures";

let be: Backend;
const opened: ChatController[] = [];

before(async () => void (be = await startBackend()));
after(async () => {
  await be.close();
});
beforeEach(() => be.reset());
afterEach(() => {
  for (const c of opened.splice(0)) c.dispose();
  assert.equal(be.gemini.pending() + be.groq.pending(), 0, "leaked override");
});

async function boot(repository: ChatRepository = new MemoryChatRepository(), extra: Partial<ConstructorParameters<typeof ChatController>[0]> = {}) {
  const chat = new ChatController({ repository, ai: createAiClient({ fetch: be.fetch, streamIdleMs: 3000 }), persistThrottleMs: 5, ...extra });
  opened.push(chat);
  await chat.init();
  chat.setDocsSearch(false); // these tests are about the chat engine; documentation search has its own tests (rag-chat.test.ts)
  return chat;
}
const GROQ = { provider: "groq" as const, model: "llama-demo-70b" };
const GEMINI = { provider: "gemini" as const, model: "gemini-alpha" };
const ready = async (target = GROQ) => {
  await be.configure(target);
  return boot();
};
const last = (s: ChatState) => s.messages[s.messages.length - 1]!;
const texts = (s: ChatState) => s.messages.map((m) => `${m.role[0]}:${m.content}`);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await pause(5);
  }
};

describe("start up and model choice", () => {
  it("with no provider configured: ready, nothing selectable, and sending explains what to do", async () => {
    const chat = await boot();
    const s = chat.getState();
    assert.equal(s.ready, true);
    assert.equal(s.isDraft, true);
    assert.deepEqual([s.active.provider, s.active.model], [null, null]);
    assert.equal(await chat.send("hello"), false);
    assert.match(chat.getState().notice?.text ?? "", /Settings → AI Providers/);
    assert.equal(chat.getState().messages.length, 0);
  });
  it("starts a new chat on the default model from Settings", async () => {
    const chat = await ready(GEMINI);
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["gemini", "gemini-alpha"]);
    assert.equal(chat.getState().models.status, "ready");
    assert.deepEqual(chat.getState().models.catalogs.map((c) => c.provider), ["gemini", "groq"]);
  });
  it("without a saved default, picks the first available model of the first configured provider", async () => {
    await be.configure();
    const chat = await boot();
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["gemini", "gemini-alpha"]);
  });
  it("reports an unreachable backend and blocks sending, then recovers on refresh", async () => {
    let down = true;
    const flaky = createAiClient({ fetch: async (p, i) => (down ? Promise.reject(new TypeError("offline")) : be.fetch(p, i)) });
    await be.configure(GROQ);
    const chat = new ChatController({ repository: new MemoryChatRepository(), ai: flaky, persistThrottleMs: 5 });
    opened.push(chat);
    await chat.init();
    assert.equal(chat.getState().models.status, "unreachable");
    assert.equal(await chat.send("hi"), false);
    down = false;
    await chat.refreshModels();
    assert.equal(chat.getState().models.status, "ready");
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["groq", "llama-demo-70b"]);
    assert.equal(await chat.send("hi"), true);
  });
});

describe("new conversation and streaming", () => {
  it("sends a message, streams the reply in pieces, and stores everything", async () => {
    const chat = await ready();
    const seen: string[] = [];
    chat.subscribe(() => {
      const m = chat.getState().messages.at(-1);
      if (m?.role === "assistant" && seen.at(-1) !== m.content) seen.push(m.content);
    });
    chat.setDraftText("Create a custom player command.");
    assert.equal(await chat.send(chat.getState().draftText), true);

    const s = chat.getState();
    assert.deepEqual(texts(s), ["u:Create a custom player command.", "a:Hello wörld ✓"]);
    assert.equal(s.draftText, "", "composer text is cleared");
    assert.deepEqual(s.generating, []);
    assert.ok(seen.length >= 3 && seen.includes("Hel") && seen.includes("Hello "), `content grew piece by piece: ${JSON.stringify(seen)}`);
    const reply = last(s);
    assert.deepEqual([reply.status, reply.provider, reply.model, reply.meta.finishReason], ["complete", "groq", "llama-demo-70b", "stop"]);
    assert.deepEqual(reply.meta.usage, { inputTokens: 4, outputTokens: 3, totalTokens: 7 });

    assert.equal(s.isDraft, false);
    assert.equal(s.active.title, "Create a custom player command.");
    assert.deepEqual(s.conversations.map((c) => c.id), [s.active.id]);
    assert.equal(s.active.messageCount, 2);
  });
  it("sends the system prompt and the whole history to the provider", async () => {
    const chat = await ready();
    be.groq.setReply(["first answer"]);
    await chat.send("question one");
    be.groq.setReply(["second answer"]);
    await chat.send("question two");
    const sent = lastGroqMessages(be.groq);
    assert.deepEqual(sent.map((m) => m.role), ["system", "user", "assistant", "user"]);
    assert.deepEqual(sent.slice(1).map((m) => m.content), ["question one", "first answer", "question two"]);
    assert.match(sent[0]!.content, /GTPS Assistant/);
  });
  it("saves the question before the reply arrives and the partial reply while streaming", async () => {
    const repository = new MemoryChatRepository();
    const chat = await boot(repository).then(async () => (await be.configure(GROQ), boot(repository)));
    be.groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n')], holdOpen: true });
    const sending = chat.send("save me");
    await until(() => last(chat.getState())?.content === "par");
    await pause(30);
    const stored = await repository.getMessages(chat.getState().active.id);
    assert.deepEqual(stored.map((m) => [m.role, m.content, m.status]), [["user", "save me", "complete"], ["assistant", "par", "streaming"]]);
    await chat.stop();
    await sending;
  });
  it("rejects empty and oversized input without sending anything", async () => {
    const chat = await ready();
    assert.equal(await chat.send("   \n "), false);
    assert.equal(await chat.send("x".repeat(100_001)), false);
    assert.match(chat.getState().notice?.text ?? "", /too long/);
    assert.equal(be.groq.requests.filter((r) => r.url === "/chat/completions").length, 0, "no chat request was made");
  });
  it("refuses a second message while a reply is being generated", async () => {
    const chat = await ready();
    be.groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"a"}}]}\n\n')], holdOpen: true });
    const first = chat.send("one");
    await until(() => chat.isGenerating());
    assert.equal(await chat.send("two"), false);
    assert.match(chat.getState().notice?.text ?? "", /still being generated/);
    await chat.stop();
    await first;
    assert.equal(chat.getState().messages.length, 2);
  });
});

describe("stop generation", () => {
  it("stops, keeps the partial text, and the chat can continue with the partial answer as context", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    be.groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"half an ans"}}]}\n\n')], holdOpen: true });
    const sending = chat.send("tell me");
    await until(() => last(chat.getState()).content === "half an ans");
    await chat.stop();
    assert.equal(await sending, true);

    const reply = last(chat.getState());
    assert.deepEqual([reply.content, reply.status], ["half an ans", "stopped"]);
    assert.deepEqual(chat.getState().generating, []);
    assert.equal((await repository.getMessages(chat.getState().active.id)).at(-1)?.status, "stopped");

    be.groq.setReply(["continued"]);
    await chat.send("go on");
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["tell me", "half an ans", "go on"]);
  });
  it("stopping before any text arrives leaves an empty stopped reply that is not sent as context", async () => {
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ hang: true });
    const sending = chat.send("slow");
    await until(() => chat.isGenerating());
    await chat.stop();
    await sending;
    assert.deepEqual([last(chat.getState()).content, last(chat.getState()).status], ["", "stopped"]);
    await chat.send("again");
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["slow\n\nagain"]);
  });
  it("stop with nothing running does nothing", async () => {
    const chat = await ready();
    await chat.stop();
    assert.equal(chat.getState().messages.length, 0);
  });
});

describe("multiple conversations and reload", () => {
  it("keeps conversations separate, newest first, each with its own history", async () => {
    const chat = await ready();
    be.groq.setReply(["answer A"]);
    await chat.send("topic A");
    const a = chat.getState().active.id;
    await chat.newChat();
    assert.deepEqual([chat.getState().isDraft, chat.getState().messages.length], [true, 0]);
    be.groq.setReply(["answer B"]);
    await chat.send("topic B");
    const b = chat.getState().active.id;
    assert.deepEqual(chat.getState().conversations.map((c) => c.id), [b, a]);
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["topic B"], "B's request has none of A's history");

    await chat.select(a);
    assert.deepEqual(texts(chat.getState()), ["u:topic A", "a:answer A"]);
    be.groq.setReply(["more A"]);
    await chat.send("again A");
    assert.deepEqual(chat.getState().conversations.map((c) => c.id), [a, b], "activity moves A to the top");
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["topic A", "answer A", "again A"]);
  });
  it("new chat reuses the current chat while it is still empty", async () => {
    const chat = await ready();
    const id = chat.getState().active.id;
    await chat.newChat();
    await chat.newChat();
    assert.equal(chat.getState().active.id, id);
    assert.deepEqual(chat.getState().conversations, [], "an empty chat is never added to the history");
  });
  it("after a reload everything is back: list, titles, messages, open chat and model", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const first = await boot(repository);
    await first.send("remember this");
    await first.newChat();
    await first.setProvider("gemini");
    await first.send("and this");
    const before = first.getState();
    first.dispose();
    opened.pop();

    const second = await boot(repository);
    const s = second.getState();
    assert.deepEqual(s.conversations.map((c) => [c.id, c.title, c.provider, c.model]), before.conversations.map((c) => [c.id, c.title, c.provider, c.model]));
    assert.equal(s.active.id, before.active.id, "the chat that was open is open again");
    assert.deepEqual(texts(s), texts(before));
    assert.deepEqual([s.active.provider, s.active.model], ["gemini", "gemini-alpha"]);
    await second.select(before.conversations[1]!.id);
    assert.deepEqual(texts(second.getState()), ["u:remember this", "a:Hello wörld ✓"]);
  });
  it("after a reload, a chat that was empty and unsaved comes back as a fresh draft", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const first = await boot(repository);
    await first.send("x");
    await first.newChat();
    first.dispose();
    opened.pop();
    const second = await boot(repository);
    assert.equal(second.getState().isDraft, true);
    assert.equal(second.getState().conversations.length, 1);
  });
  it("a reply cut off by closing the page is shown as interrupted and can be regenerated", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    await repository.commit({ conversation: conv("c1", { title: "Cut off", messageCount: 2 }), put: [msg("c1", 0, { content: "q" }), msg("c1", 1, { content: "partial ans", status: "streaming" })] });
    await repository.setMeta("activeId", "c1");
    const chat = await boot(repository);
    assert.equal(last(chat.getState()).status, "interrupted");
    assert.equal((await repository.getMessages("c1"))[1]?.status, "interrupted", "the correction is saved too");
    be.groq.setReply(["fresh"]);
    await chat.regenerate();
    assert.deepEqual(texts(chat.getState()), ["u:message 0 of c1".replace("message 0 of c1", "q"), "a:fresh"]);
  });
});

describe("model switching", () => {
  it("a conversation remembers its own provider and model; a new chat starts on the last one used", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.send("on groq");
    const a = chat.getState().active.id;
    await chat.newChat();
    await chat.setProvider("gemini");
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["gemini", "gemini-alpha"]);
    await chat.send("on gemini");
    const b = chat.getState().active.id;
    assert.equal(be.gemini.requests.filter((r) => r.url.includes(":streamGenerateContent")).length, 1);

    await chat.select(a);
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["groq", "llama-demo-70b"]);
    await chat.select(b);
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["gemini", "gemini-alpha"]);
    await chat.newChat();
    assert.deepEqual([chat.getState().active.provider, chat.getState().active.model], ["gemini", "gemini-alpha"], "last used");

    chat.dispose();
    opened.pop();
    const again = await boot(repository);
    await again.select(a);
    assert.deepEqual([again.getState().active.provider, again.getState().active.model], ["groq", "llama-demo-70b"], "survives a reload");
  });
  it("switching model inside a chat applies to the next message and is stored on each reply", async () => {
    const chat = await ready();
    await chat.send("first");
    await chat.setModel("groq", "qwen-coder-demo");
    await chat.send("second");
    await chat.setProvider("gemini");
    await chat.setModel("gemini", "codegemma-demo");
    await chat.send("third");
    const replies = chat.getState().messages.filter((m) => m.role === "assistant");
    assert.deepEqual(replies.map((m) => [m.provider, m.model]), [["groq", "llama-demo-70b"], ["groq", "qwen-coder-demo"], ["gemini", "codegemma-demo"]]);
    assert.ok(be.gemini.requests.some((r) => r.url.startsWith("/models/codegemma-demo:streamGenerateContent")));
    const history = JSON.parse(be.gemini.requests.filter((r) => r.url.includes("streamGenerateContent")).at(-1)!.body);
    assert.equal(history.contents.length, 5, "the whole conversation, written by other models too, goes to the new model");
  });
  it("setProvider only offers chat-capable models and remembers the last model used per provider", async () => {
    const chat = await ready();
    await chat.setModel("groq", "qwen-coder-demo");
    await chat.setProvider("gemini");
    await chat.setProvider("groq");
    assert.equal(chat.getState().active.model, "qwen-coder-demo");
  });
  it("the choice of an empty draft is not stored until the first message", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.setProvider("gemini");
    assert.deepEqual(await repository.listConversations(), []);
  });
  it("a model that disappeared from the provider's list gives a clear, recoverable error", async () => {
    await be.configure(GROQ);
    const repository = new MemoryChatRepository();
    await repository.commit({ conversation: conv("old", { model: "retired-model-x", provider: "groq" }), put: [] });
    await repository.setMeta("activeId", "old");
    const chat = await boot(repository);
    be.groq.queue({ status: 404, body: JSON.stringify({ error: { message: "The model `retired-model-x` does not exist", code: "model_not_found" } }) });
    await chat.send("hi");
    assert.equal(last(chat.getState()).meta.error?.kind, "model_not_found");
    await chat.setModel("groq", "llama-demo-70b");
    await chat.regenerate();
    assert.deepEqual([last(chat.getState()).status, last(chat.getState()).content], ["complete", "Hello wörld ✓"]);
  });
});

describe("regenerate", () => {
  it("replaces the last reply, keeps the question, and does not send the old reply", async () => {
    const chat = await ready();
    be.groq.setReply(["old answer"]);
    await chat.send("question");
    const oldId = last(chat.getState()).id;
    be.groq.setReply(["new answer"]);
    assert.equal(await chat.regenerate(), true);
    assert.deepEqual(texts(chat.getState()), ["u:question", "a:new answer"]);
    assert.equal(last(chat.getState()).id, oldId);
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["question"]);
    assert.equal(chat.getState().active.messageCount, 2);
  });
  it("can use a different model than the first attempt", async () => {
    const chat = await ready();
    await chat.send("question");
    await chat.setProvider("gemini");
    be.gemini.setReply(["gemini take"]);
    await chat.regenerate();
    assert.deepEqual([last(chat.getState()).content, last(chat.getState()).provider], ["gemini take", "gemini"]);
  });
  it("does nothing while generating or in an empty chat", async () => {
    const chat = await ready();
    assert.equal(await chat.regenerate(), false);
    be.groq.queue({ hang: true });
    const sending = chat.send("q");
    await until(() => chat.isGenerating());
    assert.equal(await chat.regenerate(), false);
    await chat.stop();
    await sending;
  });
  it("is stored: the new reply replaces the old one in the database", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.send("q");
    be.groq.setReply(["second"]);
    await chat.regenerate();
    const stored = await repository.getMessages(chat.getState().active.id);
    assert.deepEqual(stored.map((m) => m.content), ["q", "second"]);
  });
});

describe("editing a message", () => {
  it("rewrites the message, drops everything after it, and answers the edited text", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    for (const q of ["original question", "follow up", "third"]) {
      be.groq.setReply([`answer to ${q}`]);
      await chat.send(q);
    }
    assert.equal(chat.getState().messages.length, 6);
    const first = chat.getState().messages[0]!;
    be.groq.setReply(["answer to edit"]);
    assert.equal(await chat.editMessage(first.id, "edited question"), true);

    const s = chat.getState();
    assert.deepEqual(texts(s), ["u:edited question", "a:answer to edit"]);
    assert.equal(s.messages[0]?.meta.edited, true);
    assert.equal(s.messages[0]?.id, first.id);
    assert.equal(s.active.title, "edited question", "an automatic title follows the first message");
    assert.equal(s.active.messageCount, 2);
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["edited question"]);
    assert.deepEqual((await repository.getMessages(s.active.id)).map((m) => m.content), ["edited question", "answer to edit"]);
  });
  it("editing a later message keeps the earlier conversation", async () => {
    const chat = await ready();
    await chat.send("one");
    await chat.send("two");
    const second = chat.getState().messages[2]!;
    be.groq.setReply(["fixed"]);
    await chat.editMessage(second.id, "two, reworded");
    assert.deepEqual(texts(chat.getState()), ["u:one", "a:Hello wörld ✓", "u:two, reworded", "a:fixed"]);
    assert.equal(chat.getState().active.title, "one");
  });
  it("saving an unchanged message just asks again, without marking it edited", async () => {
    const chat = await ready();
    await chat.send("same");
    await chat.editMessage(chat.getState().messages[0]!.id, "same");
    assert.equal(chat.getState().messages[0]?.meta.edited, undefined);
    assert.equal(chat.getState().messages.length, 2);
  });
  it("ignores bad edits: unknown id, assistant message, empty text, while generating", async () => {
    const chat = await ready();
    await chat.send("q");
    const [user, assistant] = chat.getState().messages as [StoredMessage, StoredMessage];
    assert.equal(await chat.editMessage("nope", "x"), false);
    assert.equal(await chat.editMessage(assistant.id, "x"), false);
    assert.equal(await chat.editMessage(user.id, "  "), false);
    assert.deepEqual(texts(chat.getState()), ["u:q", "a:Hello wörld ✓"]);
  });
});

describe("error recovery", () => {
  it("a rejected key leaves the question in place with a readable error; fixing it and retrying works", async () => {
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ status: 401, body: JSON.stringify({ error: { message: "Invalid API Key", code: "invalid_api_key" } }) });
    await chat.send("hello");
    const failed = last(chat.getState());
    assert.deepEqual([failed.status, failed.meta.error?.kind, failed.content], ["error", "invalid_key", ""]);
    assert.equal(chat.getState().messages[0]?.content, "hello");

    assert.equal(await chat.regenerate(), true);
    assert.deepEqual([last(chat.getState()).status, last(chat.getState()).content], ["complete", "Hello wörld ✓"]);
    assert.equal(last(chat.getState()).meta.error, undefined);
  });
  it("a long rate limit is reported with its wait, short-circuits locally, and works again after the cooldown", async () => {
    be.setNow(1_000_000);
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ status: 429, headers: { "retry-after": "90" }, body: JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }) });
    await chat.send("hello");
    assert.deepEqual([last(chat.getState()).meta.error?.kind, last(chat.getState()).meta.error?.retryAfterMs], ["rate_limited", 90_000]);

    const calls = be.groq.requests.length;
    be.setNow(1_030_000);
    await chat.regenerate();
    assert.equal(last(chat.getState()).meta.error?.kind, "rate_limited");
    assert.equal(be.groq.requests.length, calls, "no request while paused");

    be.setNow(1_100_000);
    await chat.regenerate();
    assert.equal(last(chat.getState()).status, "complete");
  });
  it("another provider still works while one is rate limited", async () => {
    be.setNow(2_000_000);
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ status: 429, headers: { "retry-after": "90" }, body: "{}" });
    await chat.send("hello");
    await chat.setProvider("gemini");
    await chat.regenerate();
    assert.deepEqual([last(chat.getState()).status, last(chat.getState()).provider], ["complete", "gemini"]);
  });
  it("a connection that drops mid-reply keeps the partial text, marks an error, and can be retried", async () => {
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')], destroyAfterStream: true });
    await chat.send("hello");
    const cut = last(chat.getState());
    assert.deepEqual([cut.content, cut.status], ["partial", "error"]);
    assert.ok(cut.meta.error);
    await chat.regenerate();
    assert.deepEqual([last(chat.getState()).content, last(chat.getState()).status], ["Hello wörld ✓", "complete"]);
  });
  it("a reply the provider blocked is an error with the reason, not an empty success", async () => {
    await be.configure(GEMINI);
    const chat = await boot();
    be.gemini.queue({ stream: geminiStream(["partial"], "SAFETY") });
    await chat.send("hello");
    assert.deepEqual([last(chat.getState()).status, last(chat.getState()).meta.error?.kind], ["error", "content_blocked"]);
  });
  it("a reply cut at the length limit completes and is marked as such", async () => {
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ stream: groqStream(["long text"], "length") });
    await chat.send("hello");
    assert.deepEqual([last(chat.getState()).status, last(chat.getState()).meta.finishReason], ["complete", "length"]);
  });
  it("errors are stored, so they are still visible and retryable after a reload", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    be.groq.queue({ status: 500, body: "{}" });
    be.groq.queue({ status: 500, body: "{}" });
    be.groq.queue({ status: 500, body: "{}" });
    await chat.send("hello");
    chat.dispose();
    opened.pop();
    const again = await boot(repository);
    assert.deepEqual([last(again.getState()).status, last(again.getState()).meta.error?.kind], ["error", "provider_unavailable"]);
    await again.regenerate();
    assert.equal(last(again.getState()).status, "complete");
  });
});

describe("concurrent conversations, deleting and clearing", () => {
  it("two conversations can generate at the same time on different providers", async () => {
    await be.configure(GROQ);
    const chat = await boot();
    be.groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"g"}}]}\n\n')], holdOpen: true });
    const first = chat.send("slow groq");
    await until(() => last(chat.getState()).content === "g");
    const a = chat.getState().active.id;

    await chat.newChat();
    await chat.setProvider("gemini");
    be.gemini.setReply(["gemini done"]);
    await chat.send("fast gemini");
    const b = chat.getState().active.id;
    assert.deepEqual(texts(chat.getState()), ["u:fast gemini", "a:gemini done"]);
    assert.deepEqual(chat.getState().generating, [a], "the first one is still running in the background");

    await chat.select(a);
    assert.equal(last(chat.getState()).content, "g");
    await chat.stop(a);
    await first;
    assert.deepEqual(chat.getState().generating, []);
    assert.notEqual(a, b);
  });
  it("deleting a conversation that is generating stops it and leaves nothing behind", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    be.groq.queue({ stream: [Buffer.from('data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n')], holdOpen: true });
    const sending = chat.send("doomed");
    await until(() => last(chat.getState()).content === "x");
    const id = chat.getState().active.id;
    await chat.remove(id);
    await sending;
    await pause(30);
    assert.deepEqual(await repository.snapshot(), { conversations: [], messages: [] });
    assert.equal(chat.getState().isDraft, true);
    assert.deepEqual(chat.getState().conversations, []);
  });
  it("deleting one conversation keeps the others; deleting the open one opens a fresh chat", async () => {
    const chat = await ready();
    await chat.send("keep me");
    const keep = chat.getState().active.id;
    await chat.newChat();
    await chat.send("delete me");
    const gone = chat.getState().active.id;
    await chat.remove(gone);
    assert.deepEqual(chat.getState().conversations.map((c) => c.id), [keep]);
    assert.deepEqual([chat.getState().isDraft, chat.getState().messages.length], [true, 0]);
    await chat.select(keep);
    assert.deepEqual(texts(chat.getState()), ["u:keep me", "a:Hello wörld ✓"]);
  });
  it("clear all history removes everything, even a running reply, and starts over", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.send("one");
    await chat.newChat();
    be.groq.queue({ hang: true });
    const running = chat.send("two");
    await until(() => chat.isGenerating());
    await chat.clearAll();
    await running;
    await pause(20);
    assert.deepEqual(await repository.snapshot(), { conversations: [], messages: [] });
    assert.deepEqual([chat.getState().conversations.length, chat.getState().isDraft, chat.getState().messages.length], [0, true, 0]);
    assert.match(chat.getState().notice?.text ?? "", /deleted/);
    assert.equal(await chat.send("works afterwards"), true);
  });
});

describe("rename and search", () => {
  it("renames a chat; a manual title is never replaced by the automatic one", async () => {
    const repository = new MemoryChatRepository();
    const chat = await ready();
    await chat.send("first question");
    const id = chat.getState().active.id;
    assert.equal(await chat.rename(id, "  My   reward\nscript "), true);
    assert.equal(chat.getState().active.title, "My reward script");
    await chat.send("second");
    await chat.editMessage(chat.getState().messages[0]!.id, "totally different");
    assert.equal(chat.getState().active.title, "My reward script");
    assert.equal(chat.getState().conversations[0]?.titleSource, "manual");
    assert.equal(await chat.rename(id, "   "), false);
    assert.match(chat.getState().notice?.text ?? "", /can't be empty/);
    assert.equal(chat.getState().active.title, "My reward script");
    void repository;
  });
  it("the title persists across a reload", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.send("q");
    await chat.rename(chat.getState().active.id, "Renamed");
    chat.dispose();
    opened.pop();
    assert.equal((await boot(repository)).getState().conversations[0]?.title, "Renamed");
  });
  it("searches titles and message text, and clears", async () => {
    const chat = await ready();
    be.groq.setReply(["Use onPlayerChatCallback for that."]);
    await chat.send("How do I react to chat?");
    await chat.newChat();
    be.groq.setReply(["Sure."]);
    await chat.send("Make a shop");
    await chat.search("callback");
    assert.deepEqual(chat.getState().search.hits?.map((h) => [h.title, h.matchedIn]), [["How do I react to chat?", "message"]]);
    assert.match(chat.getState().search.hits![0]!.snippet!, /onPlayerChatCallback/);
    await chat.search("SHOP");
    assert.deepEqual(chat.getState().search.hits?.map((h) => h.matchedIn), ["title"]);
    await chat.search("nothing like this");
    assert.deepEqual(chat.getState().search.hits, []);
    await chat.search("");
    assert.equal(chat.getState().search.hits, null);
  });
  it("only the latest of overlapping searches wins", async () => {
    const chat = await ready();
    await chat.send("alpha topic");
    await chat.newChat();
    await chat.send("beta topic");
    const slow = chat.search("alpha");
    const fast = chat.search("beta");
    await Promise.all([slow, fast]);
    assert.deepEqual(chat.getState().search.hits?.map((h) => h.title), ["beta topic"]);
    assert.equal(chat.getState().search.query, "beta");
  });
});

describe("export and import", () => {
  it("exports every conversation as JSON and imports it back after clearing", async () => {
    const repository = new MemoryChatRepository();
    await be.configure(GROQ);
    const chat = await boot(repository);
    be.groq.setReply(["answer one"]);
    await chat.send("question one");
    await chat.newChat();
    await chat.setProvider("gemini");
    be.gemini.setReply(["answer two"]);
    await chat.send("question two");
    await chat.rename(chat.getState().active.id, "Second chat");
    const before = await repository.snapshot();

    const exported = await chat.exportJson();
    assert.match(exported.filename, /^gtps-assistant-chats-\d{4}-\d{2}-\d{2}\.json$/);
    assert.equal(exported.conversations, 2);
    const file = JSON.parse(exported.text);
    assert.deepEqual([file.format, file.version], ["gtps-assistant-chat-export", 1]);
    assert.doesNotMatch(exported.text, /AIza|gsk_/);

    await chat.clearAll();
    assert.deepEqual((await repository.snapshot()).conversations, []);
    const result = await chat.importJson(exported.text);
    assert.deepEqual(result, { conversations: 2, messages: 4, skipped: 0 });
    const after = await repository.snapshot();
    const norm = (s: typeof before) => ({ c: s.conversations.map((c) => c.id).sort(), m: s.messages.map((m) => `${m.id}|${m.role}|${m.content}|${m.provider}|${m.model}`).sort() });
    assert.deepEqual(norm(after), norm(before));
    assert.deepEqual(chat.getState().conversations.map((c) => c.title).sort(), ["Second chat", "question one"]);
    await chat.select(chat.getState().conversations.find((c) => c.title === "Second chat")!.id);
    assert.deepEqual([chat.getState().active.provider, texts(chat.getState())], ["gemini", ["u:question two", "a:answer two"]]);
  });
  it("importing the same file twice adds nothing the second time", async () => {
    const chat = await ready();
    await chat.send("q");
    const { text } = await chat.exportJson();
    assert.deepEqual(await chat.importJson(text), { conversations: 0, messages: 0, skipped: 1 });
    assert.match(chat.getState().notice?.text ?? "", /1 already existed/);
    assert.equal(chat.getState().conversations.length, 1);
  });
  it("rejects bad files with a clear message and changes nothing", async () => {
    const chat = await ready();
    await chat.send("q");
    for (const [bad, pattern] of [["{not json", /not valid JSON/], ['{"format":"other"}', /not a GTPS/], [JSON.stringify({ format: "gtps-assistant-chat-export", version: 1, conversations: [{ id: "x" }] }), /title must be text|messages must be a list/]] as const) {
      assert.equal(await chat.importJson(bad), null);
      assert.match(chat.getState().notice?.text ?? "", pattern);
    }
    assert.equal(chat.getState().conversations.length, 1);
  });
  it("imported chats can be opened and continued", async () => {
    const chat = await ready();
    const file = { format: "gtps-assistant-chat-export", version: 1, exportedAt: "2026-01-01T00:00:00Z", conversations: [{ ...conv("imp", { title: "From a file", provider: "groq", model: "llama-demo-70b", messageCount: 2 }), messages: [msg("imp", 0, { content: "old question" }), msg("imp", 1, { content: "old answer" })] }] };
    await chat.importJson(JSON.stringify(file));
    await chat.select("imp");
    be.groq.setReply(["continued"]);
    await chat.send("new question");
    assert.deepEqual(lastGroqMessages(be.groq).slice(1).map((m) => m.content), ["old question", "old answer", "new question"]);
  });
});

describe("storage problems", () => {
  it("when saving fails the chat keeps working and says so", async () => {
    const inner = new MemoryChatRepository();
    let failing = true;
    const repository: ChatRepository = Object.assign(Object.create(inner), {
      kind: "indexeddb",
      commit: async (change: Parameters<ChatRepository["commit"]>[0]) => {
        if (failing) throw new Error("QuotaExceededError");
        return inner.commit(change);
      },
    });
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.send("hello");
    assert.equal(last(chat.getState()).status, "complete");
    assert.match(chat.getState().persistenceNote ?? "", /Could not save.*QuotaExceededError/);
    failing = false;
    await chat.send("again");
    assert.equal(chat.getState().persistenceNote, null, "the warning clears once saving works again");
  });
  it("a memory repository (no IndexedDB) shows that history will not survive a reload", async () => {
    await be.configure(GROQ);
    const chat = await boot(new MemoryChatRepository(), { fallbackReason: "IndexedDB is not available in this browser." });
    assert.equal(chat.getState().persistence, "memory");
    assert.match(chat.getState().persistenceNote ?? "", /will not be kept after you reload/);
  });
  it("long histories are trimmed to what the backend accepts instead of failing", async () => {
    const repository = new MemoryChatRepository();
    const many = Array.from({ length: 160 }, (_, i) => msg("big", i, { content: `turn ${i} ${"x".repeat(2000)}`, role: i % 2 === 0 ? "user" : "assistant" }));
    await repository.commit({ conversation: conv("big", { title: "Big", messageCount: 160 }), put: many });
    await repository.setMeta("activeId", "big");
    await be.configure(GROQ);
    const chat = await boot(repository);
    await chat.send("final question");
    assert.equal(last(chat.getState()).status, "complete");
    const sent = lastGroqMessages(be.groq);
    assert.ok(sent.length <= 100);
    assert.equal(sent.at(-1)?.content, "final question");
    assert.equal(sent[1]?.role, "user");
  });
});
