/**
 * Behaviour every ChatRepository must have. Run against the in-memory
 * repository in Node and against the real IndexedDB in Chromium (tests/browser).
 */
import assert from "node:assert/strict";

import { buildExport, parseImport } from "@/lib/chat/export";
import type { ChatRepository } from "@/lib/chat/types";
import { conv, msg } from "./chat-fixtures";

export interface ContractCase {
  name: string;
  run(repo: ChatRepository): Promise<void>;
}

const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);

export const repositoryContract: ContractCase[] = [
  {
    name: "starts empty",
    async run(repo) {
      assert.deepEqual(await repo.listConversations(), []);
      assert.equal(await repo.getConversation("nope"), null);
      assert.deepEqual(await repo.getMessages("nope"), []);
      assert.deepEqual(await repo.search("anything"), []);
    },
  },
  {
    name: "stores conversations and returns them newest activity first, with every field",
    async run(repo) {
      const a = conv("a", { updatedAt: 10, title: "Alpha", provider: "gemini", model: "gemini-alpha", metadata: { k: "v", n: 1, b: true, z: null } });
      await repo.commit({ conversation: a });
      await repo.commit({ conversation: conv("b", { updatedAt: 30 }) });
      await repo.commit({ conversation: conv("c", { updatedAt: 20 }) });
      assert.deepEqual(ids(await repo.listConversations()), ["b", "c", "a"]);
      assert.deepEqual(await repo.getConversation("a"), a);
    },
  },
  {
    name: "stores messages in order with roles, timestamps, provider, model and metadata",
    async run(repo) {
      const m1 = msg("a", 1, { provider: "gemini", model: "gemini-alpha", meta: { finishReason: "stop", usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 } } });
      const m0 = msg("a", 0, { content: "Zażółć gęślą jaźń 🙂 — ```lua\nprint(1)\n```" });
      const m2 = msg("a", 2, { status: "error", meta: { error: { kind: "rate_limited", message: "slow", retryAfterMs: 5000 } } });
      await repo.commit({ conversation: conv("a"), put: [m2, m0, m1] });
      await repo.commit({ conversation: conv("b"), put: [msg("b", 0)] });
      assert.deepEqual(await repo.getMessages("a"), [m0, m1, m2]);
      assert.deepEqual(ids(await repo.getMessages("b")), ["b-m0"]);
    },
  },
  {
    name: "commit replaces existing records and removes messages in one step",
    async run(repo) {
      await repo.commit({ conversation: conv("a", { messageCount: 3 }), put: [msg("a", 0), msg("a", 1), msg("a", 2)] });
      await repo.commit({ conversation: conv("a", { messageCount: 2, title: "Renamed" }), put: [msg("a", 1, { content: "changed" })], removeMessageIds: ["a-m2"] });
      assert.equal((await repo.getConversation("a"))?.title, "Renamed");
      const messages = await repo.getMessages("a");
      assert.deepEqual(ids(messages), ["a-m0", "a-m1"]);
      assert.equal(messages[1]?.content, "changed");
    },
  },
  {
    name: "does not alias stored data: changing a returned object does not change the database",
    async run(repo) {
      await repo.commit({ conversation: conv("a"), put: [msg("a", 0)] });
      const c = await repo.getConversation("a");
      const m = await repo.getMessages("a");
      c!.title = "mutated";
      m[0]!.content = "mutated";
      assert.equal((await repo.getConversation("a"))?.title, "Chat a");
      assert.equal((await repo.getMessages("a"))[0]?.content, "message 0 of a");
    },
  },
  {
    name: "deleting a conversation removes its messages and only its messages",
    async run(repo) {
      await repo.commit({ conversation: conv("a"), put: [msg("a", 0), msg("a", 1)] });
      await repo.commit({ conversation: conv("b"), put: [msg("b", 0)] });
      await repo.deleteConversation("a");
      assert.equal(await repo.getConversation("a"), null);
      assert.deepEqual(await repo.getMessages("a"), []);
      assert.deepEqual(ids(await repo.getMessages("b")), ["b-m0"]);
      await repo.deleteConversation("missing"); // not an error
    },
  },
  {
    name: "clearAll removes conversations, messages and meta",
    async run(repo) {
      await repo.commit({ conversation: conv("a"), put: [msg("a", 0)] });
      await repo.setMeta("activeId", "a");
      await repo.clearAll();
      assert.deepEqual(await repo.listConversations(), []);
      assert.deepEqual((await repo.snapshot()).messages, []);
      assert.equal(await repo.getMeta("activeId"), null);
    },
  },
  {
    name: "meta values can be set, read, replaced and removed",
    async run(repo) {
      assert.equal(await repo.getMeta("k"), null);
      await repo.setMeta("k", "one");
      await repo.setMeta("k", "two");
      assert.equal(await repo.getMeta("k"), "two");
      await repo.setMeta("k", null);
      assert.equal(await repo.getMeta("k"), null);
    },
  },
  {
    name: "searches titles and message text, case-insensitively, all words required, with a snippet",
    async run(repo) {
      await repo.commit({ conversation: conv("a", { title: "Reward system", updatedAt: 1 }), put: [msg("a", 0, { content: "hello" })] });
      await repo.commit({ conversation: conv("b", { title: "Other", updatedAt: 2 }), put: [msg("b", 0, { content: "How do I give a REWARD to a player after login?" })] });
      await repo.commit({ conversation: conv("c", { title: "Unrelated", updatedAt: 3 }), put: [msg("c", 0, { content: "nothing here" })] });
      const hits = await repo.search("reward");
      assert.deepEqual(hits.map((h) => [h.conversationId, h.matchedIn]), [["b", "message"], ["a", "title"]]);
      assert.match(hits[0]?.snippet ?? "", /REWARD to a player/);
      assert.equal(hits[0]?.messageId, "b-m0");
      assert.deepEqual((await repo.search("player login")).map((h) => h.conversationId), ["b"], "both words, in any order");
      assert.deepEqual(await repo.search("player zzz"), []);
      assert.deepEqual(await repo.search("   "), []);
      assert.equal((await repo.search("reward", 1)).length, 1, "limit");
    },
  },
  {
    name: "export then import into an empty repository reproduces everything",
    async run(repo) {
      await repo.commit({ conversation: conv("a", { updatedAt: 5, messageCount: 2, titleSource: "manual", title: "Mine" }), put: [msg("a", 0), msg("a", 1, { meta: { finishReason: "stop" } })] });
      await repo.commit({ conversation: conv("b", { updatedAt: 9 }), put: [msg("b", 0)] });
      const file = buildExport(await repo.snapshot(), new Date("2026-01-01T00:00:00Z"));
      assert.equal(file.exportedAt, "2026-01-01T00:00:00.000Z");
      const text = JSON.stringify(file);
      const parsed = parseImport(text);

      await repo.clearAll();
      const result = await repo.importConversations(parsed);
      assert.deepEqual(result, { conversations: 2, messages: 3, skipped: 0 });
      assert.deepEqual(ids(await repo.listConversations()), ["b", "a"]);
      assert.deepEqual(await repo.getMessages("a"), file.conversations.find((c) => c.id === "a")!.messages);
      assert.equal((await repo.getConversation("a"))?.titleSource, "manual");
    },
  },
  {
    name: "import skips conversations that already exist and never overwrites their messages",
    async run(repo) {
      await repo.commit({ conversation: conv("a"), put: [msg("a", 0, { content: "original" })] });
      const incoming = parseImport(
        JSON.stringify({
          format: "gtps-assistant-chat-export",
          version: 1,
          exportedAt: "x",
          conversations: [
            { ...conv("a"), messages: [msg("a", 0, { content: "from file" })] },
            { ...conv("new"), messages: [msg("new", 0)] },
          ],
        }),
      );
      assert.deepEqual(await repo.importConversations(incoming), { conversations: 1, messages: 1, skipped: 1 });
      assert.equal((await repo.getMessages("a"))[0]?.content, "original");
      assert.deepEqual(ids(await repo.getMessages("new")), ["new-m0"]);
    },
  },
  {
    name: "import gives a new id to a message whose id belongs to another conversation",
    async run(repo) {
      await repo.commit({ conversation: conv("a"), put: [msg("a", 0, { content: "mine" })] });
      const clash = { ...msg("evil", 0), id: "a-m0", content: "overwrite attempt" };
      const incoming = parseImport(JSON.stringify({ format: "gtps-assistant-chat-export", version: 1, exportedAt: "x", conversations: [{ ...conv("evil"), messages: [clash] }] }));
      await repo.importConversations(incoming);
      assert.equal((await repo.getMessages("a"))[0]?.content, "mine");
      assert.equal((await repo.getMessages("evil"))[0]?.content, "overwrite attempt");
    },
  },
];
