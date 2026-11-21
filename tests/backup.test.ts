import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BACKUP_FORMAT, BackupError, buildBackup, parseBackup, sha256Hex, summarize, type BackupData } from "@/lib/backup/format";
import { DEFAULT_RESTORE_OPTIONS, isDestructive, planRestore, type RestoreOptions } from "@/lib/backup/plan";
import { applyRestore, collectData, createBackup, previewRestore, type BackupPorts } from "@/lib/backup/service";
import { ChatController } from "@/lib/chat/controller";
import { buildExport } from "@/lib/chat/export";
import { MemoryChatRepository } from "@/lib/chat/memory-repository";
import { DEFAULT_PREFERENCES } from "@/lib/preferences";
import { PreferencesStore } from "@/lib/preferences-store";
import { WorkspaceController } from "@/lib/workspace/controller";
import { MemoryWorkspaceRepository } from "@/lib/workspace/memory-repository";
import type { WorkspaceFile } from "@/lib/workspace/types";
import { conv, msg } from "./support/chat-fixtures";

const noAi = {
  getSettings: async () => { throw new Error("offline"); },
  getModels: async () => { throw new Error("offline"); },
} as never;

interface Rig extends BackupPorts {
  chatRepo: MemoryChatRepository;
  wsRepo: MemoryWorkspaceRepository;
  chat: ChatController;
  workspace: WorkspaceController;
  preferences: PreferencesStore;
}

async function rig(): Promise<Rig> {
  const chatRepo = new MemoryChatRepository();
  const wsRepo = new MemoryWorkspaceRepository();
  const chat = new ChatController({ repository: chatRepo, ai: noAi, persistThrottleMs: 0 });
  await chat.init();
  const workspace = new WorkspaceController({ repository: wsRepo, draftDelayMs: 0 });
  await workspace.init();
  return { chatRepo, wsRepo, chat, workspace, preferences: new PreferencesStore(null) };
}

async function seedChat(r: Rig, id: string, over: { title?: string; texts?: string[] } = {}) {
  const texts = over.texts ?? ["hello", "hi there"];
  await r.chat.restoreData({ conversations: [{ ...conv(id, { title: over.title ?? `Chat ${id}`, messageCount: texts.length }), messages: texts.map((t, i) => msg(id, i, { content: t })) }] });
}
const chatTitles = async (r: Rig) => (await r.chatRepo.listConversations()).map((c) => c.title).sort();
const fileNames = (r: Rig) => r.workspace.getState().files.map((f) => f.name).sort();

const OPTS = (over: Partial<RestoreOptions> = {}): RestoreOptions => ({ ...DEFAULT_RESTORE_OPTIONS, ...over });

async function sampleBackup() {
  const r = await rig();
  await seedChat(r, "a", { title: "Alpha chat" });
  await seedChat(r, "b", { title: "Beta chat", texts: ["q", "answer", "more"] });
  r.workspace.createFile("shop", "print('shop')\n");
  const id = r.workspace.getState().files.find((f) => f.name === "shop.lua")!.id;
  r.workspace.edit(id, "print('unsaved draft')\n"); // never saved
  r.preferences.set({ theme: "light", editorFontSize: 18, wrapCode: true });
  const file = await createBackup(r);
  return { r, file, text: JSON.stringify(file) };
}

describe("backup file: build and validate", () => {
  it("contains chats, files (saved text AND unsaved drafts), tabs and preferences, with real counts", async () => {
    const { file, r } = await sampleBackup();
    assert.equal(file.format, BACKUP_FORMAT);
    assert.deepEqual(file.summary, { conversations: 2, messages: 5, files: 2 });
    assert.deepEqual(file.summary, summarize(file.data));
    const shop = file.data.workspace.files.find((f) => f.name === "shop.lua")!;
    assert.equal(shop.content, "print('shop')\n");
    assert.equal(shop.draft, "print('unsaved draft')\n");
    assert.equal(file.data.preferences.theme, "light");
    assert.ok(file.data.workspace.tabs.length >= 1);
    assert.equal(r.workspace.getState().files.length, 2);
  });

  it("round-trips: parsing what was built gives the same data", async () => {
    const { file, text } = await sampleBackup();
    const parsed = await parseBackup(text);
    assert.equal(parsed.summary.messages, 5);
    assert.deepEqual(parsed.data.workspace.files, file.data.workspace.files);
    assert.deepEqual(parsed.data.preferences, file.data.preferences);
    assert.deepEqual(parsed.data.chats.conversations.map((c) => c.id).sort(), ["a", "b"]);
    assert.deepEqual(parsed.warnings, []);
  });

  it("never contains API keys or server-side settings", async () => {
    const { text } = await sampleBackup();
    assert.deepEqual(Object.keys(JSON.parse(text).data).sort(), ["chats", "preferences", "workspace"]);
    for (const forbidden of [/AIza[0-9A-Za-z_-]{10,}/, /gsk_[0-9A-Za-z]{10,}/, /apiKey/i, /extraDomains/, /sourceUrl/, /GEMINI_API_KEY/]) assert.doesNotMatch(text, forbidden);
  });

  const rejects = async (text: string, message: RegExp) => {
    await assert.rejects(parseBackup(text), (e: unknown) => e instanceof BackupError && message.test(e.message), `expected ${message}`);
  };

  it("rejects damaged input with a readable reason", async () => {
    const { text, file } = await sampleBackup();
    await rejects("", /not valid JSON/);
    await rejects(text.slice(0, text.length - 40), /not valid JSON/);
    await rejects("[1,2]", /not a GTPS Assistant backup/);
    await rejects(JSON.stringify({ format: "other" }), /not a GTPS Assistant backup/);
    await rejects(JSON.stringify(buildExport({ conversations: [], messages: [] })), /chat export, not a full backup/);
    await rejects(JSON.stringify({ ...file, version: 99 }), /newer version/);
    await rejects(JSON.stringify({ ...file, version: "1" }), /no valid version/);
    await rejects(JSON.stringify({ ...file, checksum: undefined }), /no checksum/);
    await rejects(JSON.stringify({ ...file, data: undefined }), /no data section/);
  });

  it("detects an edited file through the checksum", async () => {
    const { text } = await sampleBackup();
    await rejects(text.replace("hello", "HELLO"), /checksum does not match/);
    const obj = JSON.parse(text);
    obj.data.preferences.theme = "dark";
    await rejects(JSON.stringify(obj), /checksum does not match/);
  });

  it("rejects a correctly signed file whose content is malformed (not just a bad checksum)", async () => {
    const { file } = await sampleBackup();
    const bad = async (mutate: (d: BackupData) => void, re: RegExp) => {
      const data = structuredClone(file.data);
      mutate(data);
      // Signed correctly on purpose, so only the content validation can refuse it.
      const signed = { ...file, data, checksum: { algorithm: "SHA-256", value: await sha256Hex(JSON.stringify(data)) } };
      await rejects(JSON.stringify(signed), re);
    };
    await bad((d) => { d.chats.conversations[0]!.messages[0]!.role = "system" as never; }, /Chats:.*role/);
    await bad((d) => { d.workspace.files[0]!.id = d.workspace.files[1]!.id; }, /duplicate id/);
    await bad((d) => { d.workspace.files[1]!.name = d.workspace.files[0]!.name; }, /already called/);
    await bad((d) => { (d.workspace.files[0] as { content: unknown }).content = 5; }, /text is missing/);
    await bad((d) => { (d.workspace as { files: unknown }).files = "no"; }, /file list is missing/);
    await bad((d) => { (d as { workspace: unknown }).workspace = null; }, /no workspace section/);
    await bad((d) => { (d as { chats: unknown }).chats = {}; }, /no chats section/);
  });

  it("repairs what can be repaired and says so: odd file names, junk preferences, dangling tabs", async () => {
    const { file } = await sampleBackup();
    const data = structuredClone(file.data) as BackupData & { preferences: Record<string, unknown> };
    data.workspace.files[0]!.name = "My Script!.lua";
    data.workspace.tabs = ["nope", ...data.workspace.tabs];
    data.preferences.editorFontSize = 999;
    const parsed = await parseBackup(JSON.stringify(await buildBackup(data)));
    assert.match(parsed.warnings.join("|"), /"My Script!.lua" was changed to "my_script.lua"/);
    assert.ok(!parsed.data.workspace.tabs.includes("nope"));
    assert.equal(parsed.data.preferences.editorFontSize, DEFAULT_PREFERENCES.editorFontSize);
  });
});

describe("restore plan (nothing is changed)", () => {
  it("classifies items as new, identical or conflicting, by real comparison", async () => {
    const { text } = await sampleBackup();
    const backup = await parseBackup(text);
    const r = await rig();
    await seedChat(r, "a", { title: "Alpha chat" }); // identical
    await seedChat(r, "b", { title: "Beta chat", texts: ["q", "DIFFERENT", "more"] }); // conflict
    const plan = await previewRestore(r, backup, OPTS());
    assert.deepEqual(plan.chats.identical.map((i) => i.id), ["a"]);
    assert.deepEqual(plan.chats.conflicts.map((i) => i.id), ["b"]);
    assert.equal(plan.chats.added.length, 0);
    assert.deepEqual(plan.files.added.map((i) => i.label), ["shop.lua"]);
    assert.deepEqual(plan.files.identical.map((i) => i.label), ["main.lua"], "both sides have the same starter file");
    assert.deepEqual(await chatTitles(r), ["Alpha chat", "Beta chat"], "preview changed nothing");
  });

  it("is destructive only when something would be deleted or overwritten", async () => {
    const { text } = await sampleBackup();
    const backup = await parseBackup(text);
    const empty = await rig();
    assert.equal(isDestructive(await previewRestore(empty, backup, OPTS())), false);
    assert.equal(isDestructive(await previewRestore(empty, backup, OPTS({ onConflict: "replace" }))), false, "nothing to replace in an empty browser");
    const full = await rig();
    await seedChat(full, "x");
    assert.equal(isDestructive(await previewRestore(full, backup, OPTS({ mode: "replace-all" }))), true);
    assert.equal(isDestructive(await previewRestore(full, backup, OPTS())), false, "merge with keep-both never deletes");
  });
});

describe("restore applied to the real controllers", () => {
  it("into an empty browser (replace-all): chats, files, drafts, tabs and preferences all come back", async () => {
    const { text } = await sampleBackup();
    const target = await rig();
    const { report } = await applyRestore(target, await parseBackup(text), OPTS({ mode: "replace-all", preferences: true }));
    assert.equal(report.chatsAdded, 2);
    assert.deepEqual(await chatTitles(target), ["Alpha chat", "Beta chat"]);
    assert.equal((await target.chatRepo.getMessages("b")).length, 3);
    assert.deepEqual(fileNames(target), ["main.lua", "shop.lua"]);
    const shop = target.workspace.getState().files.find((f) => f.name === "shop.lua")!;
    assert.equal(shop.content, "print('shop')\n");
    assert.equal(shop.draft, "print('unsaved draft')\n");
    assert.equal(target.preferences.get().theme, "light");
    assert.equal(target.preferences.get().editorFontSize, 18);
    // The restore is really in storage, not just in memory: a fresh controller over the same storage sees it.
    const again = new WorkspaceController({ repository: target.wsRepo, draftDelayMs: 0 });
    await again.init();
    assert.deepEqual(again.getState().files.map((f) => f.name).sort(), ["main.lua", "shop.lua"]);
    assert.equal(again.getState().files.find((f) => f.name === "shop.lua")!.draft, "print('unsaved draft')\n");
    assert.deepEqual(again.getState().tabs.length >= 1, true);
  });

  it("merge with keep-both adds the backup's version next to yours and deletes nothing", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "b", { title: "Beta chat", texts: ["q", "MINE", "more"] });
    r.workspace.createFile("shop", "print('my own shop')\n");
    const before = { chats: await chatTitles(r), files: fileNames(r) };
    const { report } = await applyRestore(r, await parseBackup(text), OPTS());
    const chats = await chatTitles(r);
    assert.deepEqual(chats, ["Alpha chat", "Beta chat", "Beta chat (restored)"]);
    assert.equal((await r.chatRepo.getMessages("b"))[1]!.content, "MINE", "my chat is untouched");
    assert.deepEqual(fileNames(r), ["main.lua", "shop.lua", "shop_2.lua"]);
    assert.equal(r.workspace.getState().files.find((f) => f.name === "shop.lua")!.content, "print('my own shop')\n");
    assert.equal(report.filesAdded, 1);
    for (const t of before.chats) assert.ok(chats.includes(t));
    for (const n of before.files) assert.ok(fileNames(r).includes(n));
  });

  it("restoring the same backup twice does not pile up copies", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "b", { title: "Beta chat", texts: ["q", "MINE", "more"] });
    r.workspace.createFile("shop", "print('my own shop')\n");
    const backup = await parseBackup(text);
    await applyRestore(r, backup, OPTS());
    const once = { chats: await chatTitles(r), files: fileNames(r) };
    const second = await applyRestore(r, backup, OPTS());
    assert.deepEqual({ chats: await chatTitles(r), files: fileNames(r) }, once);
    assert.equal(second.report.filesAdded, 0);
    assert.equal(second.report.chatsAdded, 0);
  });

  it("merge with skip keeps yours and ignores the conflicting items", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "b", { title: "Beta chat", texts: ["q", "MINE", "more"] });
    r.workspace.createFile("shop", "print('my own shop')\n");
    await applyRestore(r, await parseBackup(text), OPTS({ onConflict: "skip" }));
    assert.deepEqual(await chatTitles(r), ["Alpha chat", "Beta chat"]);
    assert.equal((await r.chatRepo.getMessages("b"))[1]!.content, "MINE");
    assert.deepEqual(fileNames(r), ["main.lua", "shop.lua"]);
    assert.equal(r.workspace.getState().files.find((f) => f.name === "shop.lua")!.content, "print('my own shop')\n");
  });

  it("merge with replace overwrites only the conflicting items", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "b", { title: "Beta chat", texts: ["q", "MINE", "more"] });
    await seedChat(r, "keep", { title: "Untouched" });
    r.workspace.createFile("shop", "print('my own shop')\n");
    await applyRestore(r, await parseBackup(text), OPTS({ onConflict: "replace" }));
    assert.deepEqual(await chatTitles(r), ["Alpha chat", "Beta chat", "Untouched"]);
    assert.equal((await r.chatRepo.getMessages("b"))[1]!.content, "answer");
    assert.equal(r.workspace.getState().files.find((f) => f.name === "shop.lua")!.content, "print('shop')\n");
    assert.ok(fileNames(r).includes("main.lua"), "files that are not in the backup stay");
  });

  it("replace-all removes what the backup does not have, and says how many", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "mine1");
    await seedChat(r, "mine2");
    const { report } = await applyRestore(r, await parseBackup(text), OPTS({ mode: "replace-all" }));
    assert.equal(report.chatsRemoved, 2);
    assert.deepEqual(await chatTitles(r), ["Alpha chat", "Beta chat"]);
    assert.equal(report.filesRemoved, 1);
  });

  it("preferences are left alone unless asked for", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    r.preferences.set({ theme: "dark", editorFontSize: 11 });
    await applyRestore(r, await parseBackup(text), OPTS());
    assert.equal(r.preferences.get().editorFontSize, 11);
    await applyRestore(r, await parseBackup(text), OPTS({ preferences: true }));
    assert.equal(r.preferences.get().editorFontSize, 18);
  });

  it("a failure half-way puts everything back (chats written, workspace fails)", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "mine", { title: "My chat" });
    r.workspace.createFile("mine", "print('mine')\n");
    r.preferences.set({ editorFontSize: 11 });
    await r.workspace.flush();
    const before = await collectData(r);
    const realPut = r.wsRepo.putFiles.bind(r.wsRepo);
    let failures = 1;
    r.wsRepo.putFiles = async (files: WorkspaceFile[]) => {
      if (failures-- > 0) throw new Error("disk full");
      return realPut(files);
    };
    await assert.rejects(applyRestore(r, await parseBackup(text), OPTS({ mode: "replace-all", preferences: true })), /disk full/);
    const after = await collectData(r);
    assert.deepEqual(after.chats.conversations.map((c) => [c.id, c.title, c.messages.length]), before.chats.conversations.map((c) => [c.id, c.title, c.messages.length]));
    assert.deepEqual(after.workspace.files.map((f) => [f.name, f.content]), before.workspace.files.map((f) => [f.name, f.content]));
    assert.equal(r.preferences.get().editorFontSize, 11);
  });

  it("the open chat is closed when a restore replaces it, so no stale messages stay on screen", async () => {
    const { text } = await sampleBackup();
    const r = await rig();
    await seedChat(r, "b", { title: "Beta chat", texts: ["q", "MINE", "more"] });
    await r.chat.select("b");
    assert.equal(r.chat.getState().messages[1]!.content, "MINE");
    await applyRestore(r, await parseBackup(text), OPTS({ onConflict: "replace" }));
    assert.equal(r.chat.getState().isDraft, true);
    assert.equal(r.chat.getState().messages.length, 0);
    await r.chat.select("b");
    assert.equal(r.chat.getState().messages[1]!.content, "answer");
  });

  it("an empty backup is valid and restoring it in merge mode changes nothing", async () => {
    const empty = await rig();
    await empty.workspace.restoreData({ files: [], replaceAll: true });
    const file = await createBackup(empty);
    assert.deepEqual(file.summary, { conversations: 0, messages: 0, files: 0 });
    const r = await rig();
    await seedChat(r, "x");
    const before = { chats: await chatTitles(r), files: fileNames(r) };
    await applyRestore(r, await parseBackup(JSON.stringify(file)), OPTS());
    assert.deepEqual({ chats: await chatTitles(r), files: fileNames(r) }, before);
  });
});

describe("plan details", () => {
  it("planRestore is pure: same inputs, same plan", async () => {
    const { file } = await sampleBackup();
    const current = { conversations: [], files: [], preferences: { ...DEFAULT_PREFERENCES } };
    const a = planRestore(file.data, current, OPTS());
    const b = planRestore(file.data, current, OPTS());
    assert.deepEqual(a.chats.added, b.chats.added);
    assert.equal(a.apply.files.files.length, 2);
  });

  it("a backup read while the workspace is still loading waits for the load instead of seeing an empty workspace", async () => {
    const wsRepo = new MemoryWorkspaceRepository();
    await wsRepo.putFiles([{ id: "f1", name: "kept.lua", content: "print(1)", draft: null, createdAt: 1, updatedAt: 1 }]);
    const slow = new Proxy(wsRepo, {
      get(target, prop, receiver) {
        if (prop === "listFiles") return async () => { await new Promise((r) => setTimeout(r, 30)); return target.listFiles(); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const workspace = new WorkspaceController({ repository: slow, draftDelayMs: 0 });
    void workspace.init(); // not awaited: the controller is visible to the UI before it is ready
    assert.notEqual(workspace.getState().status, "ready");
    const data = await workspace.backupData();
    assert.deepEqual(data.files.map((f) => f.name), ["kept.lua"]);
  });
});
