/** Pure chat logic (context building, titles, search, export/import validation) and the in-memory repository. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildContext, deriveTitle, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGE_CHARS, MAX_CONTEXT_TOTAL_CHARS, SYSTEM_PROMPT } from "@/lib/chat/context";
import { buildExport, ImportError, parseImport } from "@/lib/chat/export";
import { MemoryChatRepository } from "@/lib/chat/memory-repository";
import { searchConversations, snippetAround } from "@/lib/chat/search";
import { validateChatRequest } from "@/server/ai/validate";
import { conv, msg } from "./support/chat-fixtures";
import { repositoryContract } from "./support/chat-repo-contract";

describe("MemoryChatRepository follows the repository contract", () => {
  for (const c of repositoryContract) it(c.name, () => c.run(new MemoryChatRepository()));
});

describe("buildContext", () => {
  const u = (order: number, content: string, over = {}) => msg("a", order, { role: "user", content, ...over });
  const a = (order: number, content: string, over = {}) => msg("a", order, { role: "assistant", content, ...over });

  it("starts with the system prompt and keeps the conversation order", () => {
    const ctx = buildContext([u(0, "hi"), a(1, "hello"), u(2, "more")]);
    assert.deepEqual(ctx, [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }, { role: "user", content: "more" }]);
  });
  it("leaves out failed, empty and still-streaming replies, and merges the user messages that become adjacent", () => {
    const ctx = buildContext([u(0, "first"), a(1, "", { status: "error" }), u(2, "second"), a(3, "partial", { status: "error" }), u(4, "third"), a(5, "typing", { status: "streaming" })]);
    assert.deepEqual(ctx.slice(1), [{ role: "user", content: "first\n\nsecond\n\nthird" }]);
  });
  it("keeps partial replies that were stopped or interrupted", () => {
    const ctx = buildContext([u(0, "q"), a(1, "half an answ", { status: "stopped" }), u(2, "continue"), a(3, "lost", { status: "interrupted" })]);
    assert.deepEqual(ctx.slice(1).map((m) => m.content), ["q", "half an answ", "continue", "lost"]);
  });
  it("shortens an oversized message, keeping its end", () => {
    const big = `${"x".repeat(MAX_CONTEXT_MESSAGE_CHARS + 500)}END`;
    const [, only] = buildContext([u(0, big)]);
    assert.ok(only!.content.length <= MAX_CONTEXT_MESSAGE_CHARS);
    assert.ok(only!.content.endsWith("END"));
    assert.match(only!.content, /cut to fit/);
  });
  it("drops the oldest messages to respect the count and size limits, always starting with a user message", () => {
    const many = Array.from({ length: 250 }, (_, i) => (i % 2 === 0 ? u(i, `q${i}`) : a(i, `a${i}`)));
    const ctx = buildContext(many);
    assert.equal(ctx.length - 1 <= MAX_CONTEXT_MESSAGES, true);
    assert.equal(ctx[1]?.role, "user");
    assert.equal(ctx.at(-1)?.content, "a249");

    const heavy = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? u(i, "y".repeat(90_000)) : a(i, "z".repeat(90_000))));
    const trimmed = buildContext(heavy);
    assert.ok(trimmed.reduce((n, m) => n + m.content.length, 0) <= MAX_CONTEXT_TOTAL_CHARS + 100);
    assert.equal(trimmed[1]?.role, "user");
    assert.equal(trimmed.at(-1)?.role, "assistant");
  });
  it("always produces a request the backend validator accepts", () => {
    const history = Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? u(i, "q".repeat(5000)) : a(i, "a".repeat(5000))));
    const ctx = buildContext([...history, u(300, "last question")]);
    assert.doesNotThrow(() => validateChatRequest({ messages: ctx, provider: "groq", model: "m" }));
  });
});

describe("deriveTitle", () => {
  it("uses the first non-empty line, strips markdown noise, and shortens long text", () => {
    assert.equal(deriveTitle("\n\n  Create a **custom** player command  \nmore"), "Create a custom player command");
    assert.equal(deriveTitle("# Heading text"), "Heading text");
    assert.equal(deriveTitle("   "), "New chat");
    const long = deriveTitle("w".repeat(200));
    assert.equal(long.length, 48);
    assert.ok(long.endsWith("…"));
  });
});

describe("search", () => {
  const conversations = [conv("a", { title: "Lua loops", updatedAt: 3 }), conv("b", { title: "Shop", updatedAt: 2 }), conv("c", { title: "Misc", updatedAt: 1 })];
  const messages = [msg("a", 0, { content: "how to loop" }), msg("b", 0, { content: "Use onPlayerChatCallback to react to chat" }), msg("c", 0, { content: "unrelated" })];
  it("matches titles first-class and messages with a snippet, newest first", () => {
    const hits = searchConversations(conversations, messages, "CHAT");
    assert.deepEqual(hits.map((h) => [h.conversationId, h.matchedIn]), [["b", "message"]]);
    assert.match(hits[0]!.snippet!, /onPlayerChatCallback to react to chat/);
    assert.deepEqual(searchConversations(conversations, messages, "lua").map((h) => h.matchedIn), ["title"]);
  });
  it("snippets are one line and mark truncation", () => {
    const s = snippetAround(`${"a ".repeat(100)}NEEDLE${"\n b".repeat(100)}`, "needle");
    assert.ok(s.startsWith("…") && s.endsWith("…"));
    assert.ok(!s.includes("\n"));
    assert.ok(s.includes("NEEDLE"));
  });
});

describe("export and import validation", () => {
  const valid = () => JSON.parse(JSON.stringify(buildExport({ conversations: [conv("a", { messageCount: 1 })], messages: [msg("a", 0)] })));
  const parse = (value: unknown) => parseImport(JSON.stringify(value));
  const rejects = (value: unknown, pattern: RegExp) => assert.throws(() => parse(value), (e) => e instanceof ImportError && pattern.test(e.message));

  it("round-trips an export", () => {
    const [c] = parse(valid());
    assert.equal(c?.id, "a");
    assert.equal(c?.messages.length, 1);
    assert.equal(c?.messages[0]?.conversationId, "a");
  });
  it("rejects files that are not a chat export", () => {
    assert.throws(() => parseImport("not json"), /not valid JSON/);
    rejects([], /not a GTPS Assistant chat export/);
    rejects({ format: "something-else", version: 1, conversations: [] }, /not a GTPS/);
    rejects({ ...valid(), version: 2 }, /Unsupported export version 2/);
    rejects({ ...valid(), conversations: "x" }, /no conversations list/);
  });
  it("rejects malformed conversations and messages with a readable location", () => {
    const bad = (mutate: (v: any) => void) => {
      const v = valid();
      mutate(v);
      return v;
    };
    rejects(bad((v) => (v.conversations[0].id = "")), /Conversation 1: id is empty/);
    rejects(bad((v) => (v.conversations[0].title = 5)), /title must be text/);
    rejects(bad((v) => (v.conversations[0].createdAt = "yesterday")), /createdAt must be a timestamp/);
    rejects(bad((v) => (v.conversations[0].messages[0].role = "system")), /role must be user or assistant/);
    rejects(bad((v) => (v.conversations[0].messages[0].content = null)), /content must be text/);
    rejects(bad((v) => v.conversations.push(structuredClone(v.conversations[0]))), /duplicate id/);
    rejects(bad((v) => v.conversations[0].messages.push(structuredClone(v.conversations[0].messages[0]))), /duplicate id/);
    rejects(bad((v) => (v.conversations[0] = 7)), /not an object/);
  });
  it("cleans what it keeps: unknown fields dropped, order renumbered, streaming becomes interrupted, odd values defaulted", () => {
    const v = valid();
    v.conversations[0].evil = "<script>";
    v.conversations[0].provider = "openai";
    v.conversations[0].title = "   ";
    v.conversations[0].metadata = { ok: 1, nested: { a: 1 }, ["__proto__"]: "x" };
    v.conversations[0].messages[0].status = "streaming";
    v.conversations[0].messages[0].order = 99;
    v.conversations[0].messages[0].provider = "nope";
    v.conversations[0].messages[0].conversationId = "other";
    const [c] = parse(v);
    assert.equal("evil" in c!, false);
    assert.equal(c?.provider, null);
    assert.equal(c?.title, "Untitled chat");
    assert.deepEqual(c?.metadata, { ok: 1 });
    assert.equal(c?.messages[0]?.status, "interrupted");
    assert.equal(c?.messages[0]?.order, 0);
    assert.equal(c?.messages[0]?.provider, null);
    assert.equal(c?.messages[0]?.conversationId, "a");
    assert.equal(Object.getPrototypeOf(c!.metadata), Object.prototype);
  });
  it("export contains no secrets field and lists messages in order", () => {
    const file = buildExport({ conversations: [conv("a")], messages: [msg("a", 2), msg("a", 0), msg("a", 1)] });
    assert.deepEqual(file.conversations[0]?.messages.map((m) => m.order), [0, 1, 2]);
    assert.doesNotMatch(JSON.stringify(file), /api[_-]?key/i);
  });
});
