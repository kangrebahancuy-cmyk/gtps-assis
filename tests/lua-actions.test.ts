import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCRIPT_ACTIONS, buildActionPrompt, describeProblems, scriptFileName } from "@/lib/lua/actions";
import { sanitizeLuaFileName, uniqueFileName } from "@/lib/workspace-files";
import type { ScriptCheck } from "@/types/lua";

const CODE = 'print("a")\nlogToConsole("b")';
const CHECK: ScriptCheck = {
  syntax: { ok: true },
  stats: { lines: 2, functions: 0, calls: 2, units: 2 },
  apiUses: [],
  findings: [
    { kind: "undocumented_api", severity: "error", message: "GiveGems is not in the indexed GTPS documentation.", line: 4, name: "GiveGems" },
    { kind: "lua_standard", severity: "info", message: "fyi", line: null, name: null },
    { kind: "callback_signature", severity: "warning", message: "extra params", line: 7, name: "x" },
  ],
  preservation: null,
  passed: false,
};

describe("script actions", () => {
  it("offers every required action (Copy, Download and Open in Workspace are buttons of their own)", () => {
    assert.deepEqual(SCRIPT_ACTIONS.map((a) => a.label), ["Explain Code", "Optimize", "Refactor", "Add Comments", "Fix Errors", "Modify Script", "Generate Alternative"]);
    assert.deepEqual(SCRIPT_ACTIONS.filter((a) => a.mode === "chat").map((a) => a.id), ["explain"]);
    assert.deepEqual(SCRIPT_ACTIONS.filter((a) => a.needsInstruction).map((a) => a.id), ["modify"]);
  });

  it("every prompt that changes a script carries the complete code and the preservation rule", () => {
    for (const id of ["optimize", "refactor", "comments", "fix", "modify"] as const) {
      const p = buildActionPrompt(id, { code: CODE, instruction: "add a cooldown" });
      assert.ok(p.includes(`\`\`\`lua\n${CODE}\n\`\`\``), id);
      assert.match(p, /complete|every feature|exactly as it is/i, id);
    }
    assert.match(buildActionPrompt("explain", { code: CODE }), /Do not change it/);
    assert.match(buildActionPrompt("comments", { code: CODE }), /only add comments/);
    assert.match(buildActionPrompt("modify", { code: CODE, instruction: "add a cooldown" }), /Modify this script: add a cooldown/);
  });

  it("Fix Errors lists errors and warnings from the check, but not info", () => {
    assert.deepEqual(describeProblems(CHECK), [
      "- ERROR (line 4): GiveGems is not in the indexed GTPS documentation.",
      "- WARNING (line 7): extra params",
    ]);
    const p = buildActionPrompt("fix", { code: CODE, check: CHECK });
    assert.match(p, /GiveGems is not in the indexed/);
    assert.doesNotMatch(p, /fyi/);
    assert.match(buildActionPrompt("fix", { code: CODE }), /Look for bugs/);
  });

  it("Generate Alternative does not paste the old code (it would be treated as a modification)", () => {
    const p = buildActionPrompt("alternative", { code: CODE, originalRequest: "Create a shop" });
    assert.ok(!p.includes("```"));
    assert.match(p, /original request was: "Create a shop"/);
  });
});

describe("file names", () => {
  it("reads the script name from the reply", () => {
    assert.equal(scriptFileName("## Script name\n`daily_reward.lua`\n\n## Purpose\nx"), "daily_reward.lua");
    assert.equal(scriptFileName("## Script name\nDaily Reward (daily-reward.lua)\n## Purpose\nx"), "daily-reward.lua");
    assert.equal(scriptFileName("## Script name\nNo file name here\n## Purpose\nx"), "script.lua");
    assert.equal(scriptFileName("nothing"), "script.lua");
    assert.equal(scriptFileName("nothing", "x.lua"), "x.lua");
  });

  it("makes safe, unique workspace file names", () => {
    assert.equal(sanitizeLuaFileName("Daily Reward!.lua"), "daily_reward.lua");
    assert.equal(sanitizeLuaFileName("../../etc/passwd"), "etc_passwd.lua");
    assert.equal(sanitizeLuaFileName("  "), "script.lua");
    assert.equal(sanitizeLuaFileName("<b>x</b>.LUA"), "b_x_b.lua");
    assert.equal(sanitizeLuaFileName("a".repeat(200)).length, 64);
    assert.equal(uniqueFileName(["main.lua"], "shop.lua"), "shop.lua");
    assert.equal(uniqueFileName(["main.lua", "shop.lua"], "Shop.lua"), "shop_2.lua");
    assert.equal(uniqueFileName(["shop.lua", "shop_2.lua"], "shop"), "shop_3.lua");
  });
});
