/**
 * The Script Generator inside the chat engine: conversation modes, the generator request, the stored
 * report and script check, script actions (Explain goes through plain chat, the rest through the generator),
 * provider switching, regenerate/edit, persistence and export/import. Real controller -> real backend ->
 * synthetic documentation -> local fake Gemini/Groq.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { ChatController } from "@/lib/chat/controller";
import { MemoryChatRepository } from "@/lib/chat/memory-repository";
import { modeOf } from "@/lib/chat/mode";
import { parseImport } from "@/lib/chat/export";
import { buildActionPrompt } from "@/lib/lua/actions";
import { extractScript } from "@/lib/lua/extract";
import { createAiClient } from "@/services/ai-client";
import { lastGeminiRequest, lastGroqMessages, startBackend, type Backend } from "./support/backend";
import { generatorDb } from "./support/gtps-lua-fixture";

let be: Backend;
const opened: ChatController[] = [];
const { db } = generatorDb();
before(async () => void (be = await startBackend({ docsDb: db })));
after(async () => {
  await be.close();
});
beforeEach(() => be.reset());
afterEach(() => {
  for (const c of opened.splice(0)) c.dispose();
  assert.equal(be.gemini.pending() + be.groq.pending(), 0, "leaked override");
});

const GROQ = { provider: "groq" as const, model: "llama-demo-70b" };
const GEMINI = { provider: "gemini" as const, model: "gemini-alpha" };

async function boot(repository = new MemoryChatRepository()) {
  await be.configure(GROQ);
  const chat = new ChatController({ repository, ai: createAiClient({ fetch: be.fetch, streamIdleMs: 3000 }), persistThrottleMs: 5 });
  opened.push(chat);
  await chat.init();
  return { chat, repository };
}

const reply = (code: string) => `## Script name\n\`demo.lua\`\n\n## Complete Lua code\n\n\`\`\`lua\n${code}\n\`\`\`\n\n## Known limitations\nNone.`;
const SCRIPT = 'onPlayerCommandCallback(function(world, player, command, args)\n  if command == "hello" then\n    player:onConsoleMessage("Hello " .. player:getName())\n    return true\n  end\n  return false\nend)';
const last = (chat: ChatController) => chat.getState().messages[chat.getState().messages.length - 1]!;
const sysOf = () => lastGroqMessages(be.groq)[0]!.content;

describe("conversation modes", () => {
  it("a generator chat is its own kind of conversation and a draft takes the requested mode", async () => {
    const { chat } = await boot();
    assert.equal(modeOf(chat.getState().active), "chat");
    await chat.newChat("generate");
    assert.equal(chat.getState().isDraft, true, "the empty draft was reused, not duplicated");
    assert.equal(modeOf(chat.getState().active), "generate");
    assert.equal(chat.getState().active.title, "New script");
    await chat.newChat("chat");
    assert.equal(modeOf(chat.getState().active), "chat");
    assert.equal(chat.getState().active.title, "New chat");
  });

  it("ensureMode opens the latest conversation of that mode, or starts one", async () => {
    const { chat } = await boot();
    await chat.ensureMode("generate");
    assert.equal(modeOf(chat.getState().active), "generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello");
    const generatorId = chat.getState().active.id;

    await chat.ensureMode("chat");
    assert.equal(modeOf(chat.getState().active), "chat");
    assert.notEqual(chat.getState().active.id, generatorId);
    be.groq.setReply(["Hi!"]);
    await chat.send("hello");
    const chatId = chat.getState().active.id;

    await chat.ensureMode("generate");
    assert.equal(chat.getState().active.id, generatorId, "reopened the existing generator conversation");
    await chat.ensureMode("generate");
    assert.equal(chat.getState().active.id, generatorId, "idempotent");
    await chat.ensureMode("chat");
    assert.equal(chat.getState().active.id, chatId);
  });
});

describe("generating through the chat engine", () => {
  it("sends the generator request, stores the report and the script check with the reply", async () => {
    const { chat } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    assert.equal(await chat.send("Create a custom player command /hello that greets the player"), true);

    assert.match(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.match(lastGroqMessages(be.groq)[1]!.content, /Verified API reference/);

    const m = last(chat);
    assert.equal(m.status, "complete");
    assert.equal(m.meta.docs?.status, "used");
    assert.deepEqual(m.meta.docs?.generation?.features, ["custom_command"]);
    assert.equal(m.meta.check?.passed, true, JSON.stringify(m.meta.check?.findings));
    assert.equal(m.meta.check?.apiUses.find((u) => u.name === "onPlayerCommandCallback")?.status, "documented");
    assert.equal(extractScript(m.content)?.code, SCRIPT);
  });

  it("generator conversations search the documentation even when the chat switch is off", async () => {
    const { chat } = await boot();
    chat.setDocsSearch(false);
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a mailbox reward system");
    assert.equal(last(chat).meta.docs?.status, "used");
    assert.match(sysOf(), /SCRIPT GENERATOR MODE/);
  });

  it("a plain chat conversation is unaffected: no generator prompt, no check", async () => {
    const { chat } = await boot();
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello");
    assert.doesNotMatch(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.equal(last(chat).meta.check, undefined);
    assert.equal(last(chat).meta.docs?.generation, undefined);
  });

  it("an invented API in the reply is stored as a failed check", async () => {
    const { chat } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply("player:teleportToMoon()")]);
    await chat.send("Create a custom player command /moon");
    assert.equal(last(chat).meta.check?.passed, false);
    assert.equal(last(chat).meta.check?.findings.some((f) => f.kind === "undocumented_api"), true);
  });

  it("regenerate and edit run the generator again", async () => {
    const { chat } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello");
    be.groq.setReply([reply("player:teleportToMoon()")]);
    await chat.regenerate();
    assert.match(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.equal(last(chat).meta.check?.passed, false, "the new reply was checked, not the old one");

    be.groq.setReply([reply(SCRIPT)]);
    await chat.editMessage(chat.getState().messages[0]!.id, "Create a custom player command /hi");
    assert.equal(last(chat).meta.check?.passed, true);
    assert.match(lastGroqMessages(be.groq)[1]!.content, /\/hi$/);
  });
});

describe("script actions", () => {
  async function withScript() {
    const { chat, repository } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello that greets the player");
    return { chat, repository };
  }

  it("Explain Code is answered as a normal documentation-backed chat, not as a new script", async () => {
    const { chat } = await withScript();
    be.groq.setReply(["It registers a command handler [1]."]);
    await chat.send(buildActionPrompt("explain", { code: SCRIPT }), { mode: "chat" });
    assert.doesNotMatch(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.match(sysOf(), /documentation/i);
    const user = chat.getState().messages.filter((m) => m.role === "user").at(-1)!;
    assert.equal(user.meta.requestMode, "chat");
    assert.equal(last(chat).meta.check, undefined);
    assert.equal(last(chat).meta.docs?.generation, undefined);
    // regenerating repeats the same kind of request
    be.groq.setReply(["Again."]);
    await chat.regenerate();
    assert.doesNotMatch(sysOf(), /SCRIPT GENERATOR MODE/);
  });

  it("Modify Script goes through the generator and preserves what it should", async () => {
    const { chat } = await withScript();
    const cooldown = SCRIPT.replace('  if command == "hello" then', '  if command == "hello" then\n    logToConsole("hello used")');
    be.groq.setReply([reply(cooldown)]);
    await chat.send(buildActionPrompt("modify", { code: SCRIPT, instruction: "log when the command is used" }), { mode: "generate" });
    const user = chat.getState().messages.filter((m) => m.role === "user").at(-1)!;
    assert.equal(user.meta.requestMode, undefined, "same as the conversation: nothing to remember");
    const m = last(chat);
    assert.equal(m.meta.docs?.generation?.modifying, true);
    assert.deepEqual(m.meta.check?.preservation?.removed, []);
    assert.deepEqual(m.meta.check?.preservation?.modified, ["call onPlayerCommandCallback"]);
    assert.ok(lastGroqMessages(be.groq).at(-1)!.content.includes(SCRIPT), "the complete script was sent");
  });

  it("Fix Errors sends the findings of the check", async () => {
    const { chat } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply("player:teleportToMoon()")]);
    await chat.send("Create a custom player command /moon");
    const bad = last(chat);
    be.groq.setReply([reply('local p = getPlayer("x")\np:onConsoleMessage("hi")')]);
    await chat.send(buildActionPrompt("fix", { code: "player:teleportToMoon()", check: bad.meta.check }), { mode: "generate" });
    const sent = lastGroqMessages(be.groq).at(-1)!.content;
    assert.match(sent, /documentation check found these problems/);
    assert.match(sent, /player:teleportToMoon is not in the indexed GTPS documentation/);
    assert.equal(last(chat).meta.check?.passed, true);
  });

  it("Generate Alternative is a new script, not a modification of the old one", async () => {
    const { chat } = await withScript();
    be.groq.setReply([reply('onPlayerCommandCallback(function(world, player, command, args)\n  return false\nend)')]);
    await chat.send(buildActionPrompt("alternative", { originalRequest: "Create a custom player command /hello that greets the player", code: SCRIPT }), { mode: "generate" });
    assert.equal(last(chat).meta.docs?.generation?.modifying, false);
    assert.equal(last(chat).meta.check?.preservation, null);
  });
});

describe("provider switching, persistence, export/import", () => {
  it("switching provider mid-conversation keeps the generator workflow", async () => {
    await be.configure(GROQ);
    const { chat } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello");
    await be.configure(GEMINI);
    await chat.refreshModels();
    await chat.setProvider("gemini");
    be.gemini.setReply([reply(SCRIPT)]);
    await chat.send("Create a mailbox reward system");
    const sent = lastGeminiRequest(be.gemini);
    assert.match(sent.system, /SCRIPT GENERATOR MODE/);
    assert.match(sent.contents.at(-1)!.text, /Verified API reference/);
    assert.equal(last(chat).provider, "gemini");
    assert.equal(last(chat).meta.docs?.status, "used");
    assert.ok(last(chat).meta.check);
  });

  it("mode, report and check survive a reload and an export/import", async () => {
    const { chat, repository } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello");
    const id = chat.getState().active.id;
    chat.dispose();

    const { chat: again } = await (async () => {
      const c = new ChatController({ repository, ai: createAiClient({ fetch: be.fetch }), persistThrottleMs: 5 });
      opened.push(c);
      await c.init();
      return { chat: c };
    })();
    await again.select(id);
    assert.equal(modeOf(again.getState().active), "generate");
    assert.equal(last(again).meta.check?.passed, true);
    assert.equal(last(again).meta.docs?.generation?.featureLabels[0], "Custom player command");

    const exported = await again.exportJson();
    const parsed = parseImport(exported.text);
    assert.equal(modeOf(parsed[0]!), "generate");
    const m = parsed[0]!.messages[1]!;
    assert.deepEqual(m.meta.check, last(again).meta.check, "the check round-trips unchanged");
    assert.deepEqual(m.meta.docs?.generation, last(again).meta.docs?.generation);
  });

  it("an imported file cannot smuggle in a malformed check", async () => {
    const { chat } = await boot();
    await chat.newChat("generate");
    be.groq.setReply([reply(SCRIPT)]);
    await chat.send("Create a custom player command /hello");
    const file = JSON.parse((await chat.exportJson()).text);
    const meta = file.conversations[0].messages[1].meta;
    meta.check = { syntax: { ok: true }, stats: { lines: -5, functions: "x", calls: 1, units: 1 }, apiUses: [{ name: 7, status: "documented" }, { name: "ok", status: "bogus" }], findings: [{ kind: "hack", severity: "error", message: "x" }, { kind: "syntax", severity: "error", message: "<img onerror=x>", line: 3 }], preservation: { removed: "no" }, passed: "yes" };
    const parsed = parseImport(JSON.stringify(file));
    const check = parsed[0]!.messages[1]!.meta.check!;
    assert.equal(check.stats.lines, 0);
    assert.equal(check.stats.functions, 0);
    assert.deepEqual(check.apiUses, []);
    assert.equal(check.findings.length, 1);
    assert.equal(check.findings[0]?.line, 3);
    assert.deepEqual(check.preservation, { preserved: [], modified: [], removed: [], added: [] });
    assert.equal(check.passed, false);
  });
});
