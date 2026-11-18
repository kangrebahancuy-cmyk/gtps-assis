/** Server-side render of the workspace's presentational components (the interactive behaviour is covered in Chromium). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DiffView } from "@/features/workspace/diff-view";
import { FileExplorer } from "@/features/workspace/file-explorer";
import { ProblemsPanel } from "@/features/workspace/problems-panel";
import { TabBar } from "@/features/workspace/tab-bar";
import { checkSyntax } from "@/lib/workspace/validation";
import type { WorkspaceFile } from "@/lib/workspace/types";
import { verifyScript } from "@/server/lua/verify";
import { generatorDb } from "../support/gtps-lua-fixture";

(globalThis as { React?: unknown }).React = React;

const f = (id: string, name: string, over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({ id, name, content: "", draft: null, createdAt: 1, updatedAt: 1, ...over });
const files = [f("a", "main.lua"), f("b", "shop.lua", { content: "x", draft: "xy" })];

describe("TabBar", () => {
  it("lists open tabs, marks the active one, and shows the unsaved dot only for files with unsaved changes", () => {
    const out = renderToStaticMarkup(<TabBar files={files} tabs={["a", "b"]} activeId="b" onSelect={() => {}} onClose={() => {}} />);
    assert.equal((out.match(/role="tab"/g) ?? []).length, 2);
    assert.equal((out.match(/aria-selected="true"/g) ?? []).length, 1);
    assert.equal((out.match(/data-testid="unsaved-dot"/g) ?? []).length, 1);
    assert.match(out, /data-dirty="true"/);
    assert.match(out, /aria-label="Close shop\.lua"/);
  });
  it("says when no file is open", () => {
    assert.match(renderToStaticMarkup(<TabBar files={files} tabs={[]} activeId={null} onSelect={() => {}} onClose={() => {}} />), /No file open/);
  });
});

describe("FileExplorer", () => {
  it("lists files alphabetically with rename and delete actions and the file count", () => {
    const out = renderToStaticMarkup(<FileExplorer files={[files[1]!, files[0]!]} activeId="a" onOpen={() => {}} onCreate={() => {}} onRename={() => ({ ok: true, value: "x" })} onDelete={() => {}} />);
    assert.match(out, /Files \(2\)/);
    assert.ok(out.indexOf('data-name="main.lua"') < out.indexOf('data-name="shop.lua"'));
    assert.match(out, /aria-label="Rename main\.lua"/);
    assert.match(out, /aria-label="Delete shop\.lua"/);
    assert.equal((out.match(/data-testid="explorer-unsaved"/g) ?? []).length, 1);
  });
  it("explains the empty state", () => {
    assert.match(renderToStaticMarkup(<FileExplorer files={[]} activeId={null} onOpen={() => {}} onCreate={() => {}} onRename={() => ({ ok: true, value: "" })} onDelete={() => {}} />), /No files yet/);
  });
});

describe("ProblemsPanel", () => {
  const noop = () => {};
  it("keeps syntax, documentation and runtime apart, and a clean syntax check never says the script works", () => {
    const out = renderToStaticMarkup(<ProblemsPanel report={checkSyntax("print(1)")} docs={{ status: "idle" }} onGoTo={noop} onCheckDocs={noop} canCheckDocs />);
    assert.match(out, /1 · Syntax check only \(local\)/);
    assert.match(out, /2 · Documentation check \(on request\)/);
    assert.match(out, /3 · GTPS runtime/);
    assert.match(out, /No syntax errors found/);
    assert.match(out, /not GTPS runtime validation/);
    assert.match(out, /GTPS runtime: not validated/);
    assert.doesNotMatch(out, /works in GTPS|is valid|valid Lua|\bpassed\b/i);
  });
  it("lists a syntax error with its position", () => {
    const out = renderToStaticMarkup(<ProblemsPanel report={checkSyntax("if x then\n")} docs={{ status: "idle" }} onGoTo={noop} onCheckDocs={noop} canCheckDocs />);
    assert.match(out, /data-testid="syntax-problem"/);
    assert.match(out, /2:1/);
    assert.match(out, /&#x27;end&#x27; expected|'end' expected/);
  });
  it("shows a real documentation check, flags a stale one, and disables the button while running", () => {
    const { db } = generatorDb();
    const check = verifyScript(db, 'local p = getPlayer("x")\np:teleportToMoon()');
    const done = renderToStaticMarkup(<ProblemsPanel report={checkSyntax("x=1")} docs={{ status: "done", check, stale: true }} onGoTo={noop} onCheckDocs={noop} canCheckDocs />);
    assert.match(done, /data-stale="true"/);
    assert.match(done, /The code changed after this check/);
    assert.match(done, /teleportToMoon/);
    assert.match(done, /Script check found problems/);
    const running = renderToStaticMarkup(<ProblemsPanel report={null} docs={{ status: "running" }} onGoTo={noop} onCheckDocs={noop} canCheckDocs />);
    assert.match(running, /Checking…/);
    assert.match(running, /<button[^>]*disabled=""[^>]*>[^<]*(<svg[^>]*><\/svg>)?\s*Check against documentation/);
    assert.match(renderToStaticMarkup(<ProblemsPanel report={null} docs={{ status: "error", message: "The documentation check failed." }} onGoTo={noop} onCheckDocs={noop} canCheckDocs />), /role="alert"[^>]*>The documentation check failed\./);
  });
});

describe("DiffView", () => {
  it("shows additions and removals with counts, folding unchanged runs", () => {
    const before = Array.from({ length: 12 }, (_, i) => `l${i}`).join("\n");
    const out = renderToStaticMarkup(<DiffView before={before} after={before.replace("l6", "CHANGED")} />);
    assert.match(out, /\+1/);
    assert.match(out, /−1/);
    assert.equal((out.match(/data-diff="add"/g) ?? []).length, 1);
    assert.equal((out.match(/data-diff="del"/g) ?? []).length, 1);
    assert.match(out, /unchanged lines?/);
  });
});
