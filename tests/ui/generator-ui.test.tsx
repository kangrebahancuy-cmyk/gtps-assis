/**
 * Server-side render of the generator's report and action bar, fed with the real output of the request
 * analysis and the script check over the synthetic documentation.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { GenerationReport } from "@/features/chat/generation-report";
import { ScriptActions } from "@/features/chat/script-actions";
import type { StoredMessage } from "@/lib/chat/types";
import { prepareGeneration } from "@/server/lua/generate";
import { verifyScript } from "@/server/lua/verify";
import { generatorDb } from "../support/gtps-lua-fixture";

(globalThis as { React?: unknown }).React = React;
const { db } = generatorDb();

function message(request: string, code: string, original?: string, status: StoredMessage["status"] = "complete"): StoredMessage {
  const prepared = prepareGeneration(db, { provider: "groq", model: "m", mode: "generate", messages: [{ role: "user", content: request }] });
  return {
    id: "m", conversationId: "c", order: 1, role: "assistant", content: "x", createdAt: 1, updatedAt: 1, status, provider: "groq", model: "m",
    meta: { docs: prepared.context, check: verifyScript(db, code, { original }) },
  };
}

describe("GenerationReport", () => {
  it("shows the analysis with the real topic counts, and the check", () => {
    const m = message("Create an NPC shop that sells items for gems", 'local s = Shop:create("A")\nlocal p = getPlayer("x")\ns:open(p)');
    const out = renderToStaticMarkup(<GenerationReport message={m} />);
    const g = m.meta.docs!.generation!;
    assert.match(out, /data-testid="generation-report"/);
    assert.match(out, /new script · NPC shop/);
    assert.equal((out.match(/data-testid="topic"/g) ?? []).length, g.topics.length);
    for (const t of g.topics) assert.match(out, new RegExp(`data-found="${t.found}"`));
    assert.match(out, /data-testid="missing-topics"[^>]*>No documentation found for: .*Dialogs and menus/);
    assert.match(out, /data-passed="true"/);
    assert.match(out, /Syntax: no syntax errors found/);
    assert.match(out, /APIs used: 3 documented/);
    assert.match(out, /href="https:\/\/docs\.fixture\.test\/docs\/shop"/);
  });

  it("shows problems: invented API, syntax error, removed features", () => {
    const bad = renderToStaticMarkup(<GenerationReport message={message("Create a daily reward system", "GiveGems(1)\nonPlayerJoinWorld()")} />);
    assert.match(bad, /data-passed="false"/);
    assert.match(bad, /Script check found problems/);
    assert.match(bad, /data-status="undocumented"/);
    assert.match(bad, /GiveGems is not in the indexed GTPS documentation/);

    const syntax = renderToStaticMarkup(<GenerationReport message={message("Create a daily reward system", "if x then\n")} />);
    assert.match(syntax, /Syntax: error at line 2/);

    const orig = 'logToConsole("a")\nlogToConsole("b")';
    const mod = renderToStaticMarkup(<GenerationReport message={message("Add a message to this script\n```lua\n" + orig + "\n```", 'logToConsole("a")', orig)} />);
    assert.match(mod, /data-testid="preservation"/);
    assert.match(mod, /1 unchanged · 0 changed · 1 removed · 0 added/);
    assert.match(mod, /Removed: call logToConsole\(&quot;b&quot;\)/);
    assert.match(mod, /modification of an existing script/);
  });

  it("escapes anything the model or the script put in a message", () => {
    const m = message("Create a daily reward system", "x()");
    m.meta.check!.findings.push({ kind: "syntax", severity: "error", message: "<script>alert(1)</script>", line: 1, name: null });
    const out = renderToStaticMarkup(<GenerationReport message={m} />);
    assert.doesNotMatch(out, /<script>alert/);
    assert.match(out, /&lt;script&gt;/);
  });

  it("renders nothing for a reply that has no generation record", () => {
    const m = message("Create a daily reward system", "x()");
    delete m.meta.docs;
    delete m.meta.check;
    assert.equal(renderToStaticMarkup(<GenerationReport message={m} />), "");
  });

  it("says so when a finished reply had no script to check", () => {
    const m = message("Create a daily reward system", "x()");
    delete m.meta.check;
    assert.match(renderToStaticMarkup(<GenerationReport message={m} />), /No script was found in this reply, so nothing was checked/);
  });
});

describe("ScriptActions", () => {
  const props = { code: "print(1)", fileName: "demo.lua", busy: false, onOpenInWorkspace: () => {}, onAction: () => {} };

  it("offers every action by name", () => {
    const out = renderToStaticMarkup(<ScriptActions {...props} />);
    for (const label of ["Copy", "Download .lua", "Open in Lua Workspace", "Explain Code", "Optimize", "Refactor", "Add Comments", "Fix Errors", "Modify Script", "Generate Alternative"]) assert.ok(out.includes(label), label);
    assert.match(out, /aria-label="Download demo\.lua"/);
    assert.doesNotMatch(out, /disabled=""/);
  });

  it("disables request actions while a reply is being written, and everything while the code is incomplete", () => {
    const busy = renderToStaticMarkup(<ScriptActions {...props} busy />);
    assert.equal((busy.match(/disabled=""/g) ?? []).length, 7, "the seven request actions");
    const partial = renderToStaticMarkup(<ScriptActions {...props} incomplete />);
    assert.equal((partial.match(/disabled=""/g) ?? []).length, 10, "all ten buttons");
  });
});
