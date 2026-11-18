import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { STARTER_FILE_NAME, WorkspaceController } from "@/lib/workspace/controller";
import { buildProject, downloadFileName, MAX_IMPORT_BYTES, parseProject, readImportedFile, sanitizeLuaFileName, uniqueFileName } from "@/lib/workspace/files";
import { MemoryWorkspaceRepository } from "@/lib/workspace/memory-repository";
import { isDirty, textOf, type WorkspaceFile, type WorkspaceRepository } from "@/lib/workspace/types";
import { checkSyntax, RUNTIME_SCOPE, SYNTAX_SCOPE, syntaxSummary } from "@/lib/workspace/validation";
import { workspaceContract } from "./support/workspace-repo-contract";

const bytes = (s: string) => new TextEncoder().encode(s);

async function open(repo: WorkspaceRepository = new MemoryWorkspaceRepository()) {
  const ws = new WorkspaceController({ repository: repo, draftDelayMs: 0 });
  await ws.init();
  return { ws, repo };
}
/** Simulates closing and reopening the page: a new controller over the same storage. */
async function reload(ws: WorkspaceController, repo: WorkspaceRepository) {
  await ws.flush();
  return (await open(repo)).ws;
}

describe("memory repository follows the repository contract", () => {
  for (const c of workspaceContract) it(c.name, () => c.run(new MemoryWorkspaceRepository()));
});

describe("file names", () => {
  it("sanitizes and de-duplicates", () => {
    assert.equal(sanitizeLuaFileName("Daily Reward!.lua"), "daily_reward.lua");
    assert.equal(sanitizeLuaFileName("   "), "script.lua");
    assert.equal(uniqueFileName(["a.lua", "a_2.lua"], "A.lua"), "a_3.lua");
    assert.equal(downloadFileName("../../etc/passwd"), "etc_passwd.lua");
  });
});

describe("readImportedFile", () => {
  it("reads a Lua file, removes the BOM and normalises CRLF", () => {
    const r = readImportedFile("C:\\scripts\\Shop.lua", bytes("\uFEFFprint(1)\r\nprint(2)\rprint(3)\n"));
    assert.deepEqual(r, { ok: true, name: "Shop.lua", text: "print(1)\nprint(2)\nprint(3)\n" });
  });
  it("rejects wrong extensions, binary data, invalid UTF-8 and oversized files", () => {
    const ext = readImportedFile("photo.png", bytes("x"));
    assert.equal(ext.ok, false);
    assert.match(ext.ok ? "" : ext.error, /only \.lua/);
    const bin = readImportedFile("a.lua", new Uint8Array([112, 0, 113]));
    assert.match(bin.ok ? "" : bin.error, /binary/);
    const utf = readImportedFile("a.lua", new Uint8Array([0xff, 0xfe, 0x41]));
    assert.match(utf.ok ? "" : utf.error, /UTF-8/);
    const big = readImportedFile("a.lua", new Uint8Array(MAX_IMPORT_BYTES + 1).fill(97));
    assert.match(big.ok ? "" : big.error, /too large/);
    assert.equal(readImportedFile("a.lua", new Uint8Array(MAX_IMPORT_BYTES).fill(97)).ok, true);
  });
});

describe("project file", () => {
  it("round-trips", () => {
    const text = buildProject([{ name: "a.lua", content: "x\n" }, { name: "b.lua", content: "ü🙂" }], new Date("2026-01-02T03:04:05Z"));
    assert.equal(JSON.parse(text).exportedAt, "2026-01-02T03:04:05.000Z");
    assert.deepEqual(parseProject(text), { ok: true, files: [{ name: "a.lua", content: "x\n" }, { name: "b.lua", content: "ü🙂" }] });
  });
  it("rejects anything that is not a project", () => {
    for (const bad of ["nope", "{}", '{"format":"other"}', '{"format":"gtps-lua-workspace","version":2,"files":[]}', '{"format":"gtps-lua-workspace","version":1}', '{"format":"gtps-lua-workspace","version":1,"files":[{"name":1}]}']) {
      assert.equal(parseProject(bad).ok, false, bad);
    }
  });
});

describe("WorkspaceController", () => {
  it("creates one starter file the first time, and never again after it is deleted", async () => {
    const { ws, repo } = await open();
    assert.equal(ws.getState().status, "ready");
    assert.deepEqual(ws.getState().files.map((f) => f.name), [STARTER_FILE_NAME]);
    assert.equal(ws.getState().activeId, ws.getState().files[0]!.id);
    ws.deleteFile(ws.getState().files[0]!.id);
    const again = await reload(ws, repo);
    assert.deepEqual(again.getState().files, []);
    assert.equal(again.getState().activeId, null);
  });

  it("creates files with unique names, opens them in tabs and activates the newest", async () => {
    const { ws } = await open();
    const a = ws.createFile("Shop Items");
    const b = ws.createFile("Shop Items");
    assert.equal(a.name, "shop_items.lua");
    assert.equal(b.name, "shop_items_2.lua");
    assert.equal(ws.getState().tabs.length, 3);
    assert.equal(ws.getState().activeId, b.id);
    assert.equal(ws.createFile().name, "untitled.lua");
  });

  it("tracks unsaved changes, and clears them when the text returns to the saved content", async () => {
    const { ws } = await open();
    const f = ws.createFile("a", "one");
    assert.equal(isDirty(ws.file(f.id)!), false);
    ws.edit(f.id, "two");
    assert.equal(isDirty(ws.file(f.id)!), true);
    assert.equal(ws.hasUnsaved(), true);
    assert.equal(textOf(ws.file(f.id)!), "two");
    ws.edit(f.id, "one");
    assert.equal(isDirty(ws.file(f.id)!), false);
    assert.equal(ws.hasUnsaved(), false);
  });

  it("saves: the saved content changes, the unsaved mark goes, and it survives a reload", async () => {
    const { ws, repo } = await open();
    const f = ws.createFile("a", "one");
    ws.edit(f.id, "two");
    const r = await ws.save(f.id);
    assert.equal(r.ok, true);
    assert.equal(ws.file(f.id)!.content, "two");
    assert.equal(ws.file(f.id)!.draft, null);
    const again = await reload(ws, repo);
    const loaded = again.getState().files.find((x) => x.name === "a.lua")!;
    assert.equal(loaded.content, "two");
    assert.equal(isDirty(loaded), false);
  });

  it("keeps an unsaved draft across a reload without saving (and it is still unsaved)", async () => {
    const { ws, repo } = await open();
    const f = ws.createFile("a", "saved");
    ws.edit(f.id, "typed but not saved");
    const again = await reload(ws, repo);
    const loaded = again.getState().files.find((x) => x.name === "a.lua")!;
    assert.equal(loaded.content, "saved");
    assert.equal(loaded.draft, "typed but not saved");
    assert.equal(isDirty(loaded), true);
  });

  it("writes a draft by itself shortly after typing stops (no save, no flush)", async () => {
    const repo = new MemoryWorkspaceRepository();
    const ws = new WorkspaceController({ repository: repo, draftDelayMs: 20 });
    await ws.init();
    const f = ws.createFile("a", "saved");
    ws.edit(f.id, "t");
    ws.edit(f.id, "ty");
    assert.equal((await repo.listFiles()).find((x) => x.id === f.id)?.draft ?? null, null, "not written yet: still within the delay");
    await new Promise((r) => setTimeout(r, 80));
    assert.equal((await repo.listFiles()).find((x) => x.id === f.id)?.draft, "ty");
  });

  it("revert drops the draft, also in storage", async () => {
    const { ws, repo } = await open();
    const f = ws.createFile("a", "saved");
    ws.edit(f.id, "oops");
    ws.revert(f.id);
    assert.equal(textOf(ws.file(f.id)!), "saved");
    const again = await reload(ws, repo);
    assert.equal(again.getState().files.find((x) => x.name === "a.lua")!.draft, null);
  });

  it("keeps text typed while a save is being written", async () => {
    const mem = new MemoryWorkspaceRepository();
    const { ws } = await open(mem);
    const f = ws.createFile("a", "v0");
    ws.edit(f.id, "v1");
    const original = mem.putFiles.bind(mem);
    mem.putFiles = async (files) => {
      ws.edit(f.id, "v2 typed during save");
      return original(files);
    };
    await ws.save(f.id);
    assert.equal(ws.file(f.id)!.content, "v1");
    assert.equal(ws.file(f.id)!.draft, "v2 typed during save");
  });

  it("renames with sanitising, and refuses empty names and duplicates", async () => {
    const { ws, repo } = await open();
    const a = ws.createFile("a");
    ws.createFile("b");
    assert.deepEqual(ws.renameFile(a.id, "New Name"), { ok: true, value: "new_name.lua" });
    assert.equal(ws.renameFile(a.id, "B.LUA").ok, false);
    assert.equal(ws.renameFile(a.id, "  ").ok, false);
    assert.deepEqual(ws.renameFile(a.id, "new_name"), { ok: true, value: "new_name.lua" }); // same name: fine
    assert.equal(ws.renameFile("missing", "x").ok, false);
    const again = await reload(ws, repo);
    assert.ok(again.getState().files.some((f) => f.name === "new_name.lua"));
  });

  it("deletes a file, moves to a neighbouring tab, and forgets it after a reload", async () => {
    const { ws, repo } = await open();
    const a = ws.createFile("a");
    const b = ws.createFile("b");
    const c = ws.createFile("c");
    ws.openFile(b.id);
    assert.equal(ws.deleteFile(b.id), true);
    assert.equal(ws.deleteFile(b.id), false);
    assert.equal(ws.getState().activeId, c.id);
    assert.deepEqual(ws.getState().tabs.includes(b.id), false);
    const again = await reload(ws, repo);
    assert.equal(again.getState().files.some((f) => f.id === b.id), false);
    assert.equal(again.getState().files.some((f) => f.id === a.id), true);
  });

  it("opens and closes tabs; closing keeps an unsaved draft; tabs and the active tab survive a reload", async () => {
    const { ws, repo } = await open();
    const a = ws.createFile("a", "A");
    const b = ws.createFile("b", "B");
    ws.edit(a.id, "A edited");
    ws.closeTab(a.id);
    assert.equal(ws.getState().tabs.includes(a.id), false);
    assert.equal(ws.file(a.id)!.draft, "A edited");
    ws.openFile(a.id);
    ws.openFile(b.id);
    const again = await reload(ws, repo);
    assert.deepEqual(again.getState().tabs.slice(-2), [b.id, a.id]); // b was already open, so re-opening it keeps its place
    assert.equal(again.getState().activeId, b.id);
    again.closeTab(again.getState().tabs[0]!);
    again.closeTab(a.id);
    const third = await reload(again, repo);
    assert.equal(third.getState().tabs.includes(a.id), false);
    assert.equal(third.getState().files.find((f) => f.id === a.id)!.draft, "A edited");
  });

  it("imports several files at once, never overwriting, and reports the failures", async () => {
    const { ws, repo } = await open();
    ws.createFile("shop", "mine");
    const summary = await ws.importFiles([
      readImportedFile("shop.lua", bytes("print('imported')\n")),
      readImportedFile("Shop.lua", bytes("-- second\n")),
      readImportedFile("image.png", bytes("x")),
      readImportedFile("bin.lua", new Uint8Array([0, 1, 2])),
    ]);
    assert.deepEqual(summary.imported, ["shop_2.lua", "shop_3.lua"]);
    assert.equal(summary.failed.length, 2);
    assert.equal(ws.getState().files.find((f) => f.name === "shop.lua")!.content, "mine");
    assert.equal(ws.active()!.name, "shop_3.lua");
    const again = await reload(ws, repo);
    assert.equal(again.getState().files.find((f) => f.name === "shop_2.lua")!.content, "print('imported')\n");
  });

  it("exports a file with its unsaved text, and a project that imports back into a clean workspace", async () => {
    const { ws } = await open();
    const a = ws.createFile("Quest Rewards", "saved");
    ws.edit(a.id, "unsaved text");
    assert.deepEqual(ws.exportFile(a.id), { name: "quest_rewards.lua", text: "unsaved text" });
    assert.equal(ws.exportFile("missing"), null);
    const project = ws.exportProject();

    const other = (await open()).ws;
    const r = await other.importProject(project);
    assert.equal(r.ok, true);
    assert.equal(other.getState().files.find((f) => f.name === "quest_rewards.lua")!.content, "unsaved text");
    assert.equal((await other.importProject("not json")).ok, false);
  });

  it("reports a storage failure and keeps the file unsaved", async () => {
    const mem = new MemoryWorkspaceRepository();
    const { ws } = await open(mem);
    const f = ws.createFile("a", "x");
    await ws.flush();
    ws.edit(f.id, "y");
    mem.putFiles = async () => {
      throw new Error("disk full");
    };
    const r = await ws.save(f.id);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /disk full/);
    assert.match(ws.getState().error ?? "", /disk full/);
    assert.equal(isDirty(ws.file(f.id)!), true); // nothing was marked saved
    assert.equal(ws.file(f.id)!.content, "x");
  });

  it("remembers the AI model choice", async () => {
    const { ws, repo } = await open();
    ws.setAiPrefs({ provider: "groq", model: "llama-x" });
    const again = await reload(ws, repo);
    assert.deepEqual(again.getState().ai, { provider: "groq", model: "llama-x" });
  });

  it("ignores stale tab ids in storage", async () => {
    const repo = new MemoryWorkspaceRepository();
    const { ws } = await open(repo);
    await ws.flush();
    await repo.setMeta("tabs", JSON.stringify(["ghost", ws.getState().files[0]!.id]));
    await repo.setMeta("active", "ghost");
    const again = (await open(repo)).ws;
    assert.deepEqual(again.getState().tabs, [ws.getState().files[0]!.id]);
    assert.equal(again.getState().activeId, ws.getState().files[0]!.id);
  });
});

describe("syntax validation", () => {
  it("finds no errors in well-formed Lua", () => {
    const r = checkSyntax("local function f(x)\n  if x then return 1 end\nend\nprint(f(2))\n");
    assert.deepEqual({ clean: r.clean, problems: r.problems }, { clean: true, problems: [] });
    assert.equal(checkSyntax("").clean, true);
  });
  it("reports the line and column of a syntax error", () => {
    const r = checkSyntax("local x = 1\nif x then\n  print(x)\n");
    assert.equal(r.clean, false);
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0]!.message, /'end' expected/);
    assert.equal(r.problems[0]!.line, 4); // the missing 'end' is noticed at the end of the file
    assert.match(r.problems[0]!.message, /to close 'if' at line 2/);
  });
  it("never says a clean script is valid or working, and states the scope", () => {
    const summary = syntaxSummary(checkSyntax("print(1)"));
    assert.match(summary, /syntax only/i);
    assert.doesNotMatch(summary, /\b(valid|works?|working|passes?)\b/i);
    assert.match(SYNTAX_SCOPE, /not GTPS runtime validation/);
    assert.match(RUNTIME_SCOPE, /not validated/i);
  });
});
