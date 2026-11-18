/**
 * Workspace AI: prompt building for a selection or a whole file, applying results safely, line diffs, and the
 * real round trip (task runner -> AI client -> real backend -> synthetic GTPS documentation -> local fake Gemini/Groq).
 */
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { applyModes, actionDef, buildChatRequest, buildRequestText, makeTarget, planApply, runAiTask, validateTask, MAX_AI_CODE_CHARS, WORKSPACE_AI_ACTIONS, type AiTask } from "@/lib/workspace/ai-task";
import { diffLines, diffStats, foldDiff } from "@/lib/workspace/diff";
import { findAll, offsetOfLine, pickMatch, positionOf, replaceAll } from "@/lib/workspace/find";
import { checkSyntax } from "@/lib/workspace/validation";
import { createAiClient } from "@/services/ai-client";
import { GEMINI_KEY, GROQ_KEY } from "./ai-fakes";
import { lastGroqMessages, startBackend, type Backend } from "./support/backend";
import { generatorDb } from "./support/gtps-lua-fixture";

const FILE = 'local greeting = "Hello"\n\nonPlayerCommandCallback(function(world, player, command, args)\n  if command == "hello" then\n    player:onConsoleMessage(greeting .. " " .. player:getName())\n    return true\n  end\n  return false\nend)\n\nlocal function helper(x)\n  return x + 1\nend\n';

const task = (over: Partial<AiTask> & Pick<AiTask, "action">, text = FILE, sel = { start: 0, end: 0 }): AiTask => ({ instruction: "", target: makeTarget("main.lua", text, sel), ...over });

describe("makeTarget", () => {
  it("uses the whole file when nothing is selected, and the selection with line numbers and context otherwise", () => {
    const whole = makeTarget("main.lua", FILE, { start: 5, end: 5 });
    assert.deepEqual({ kind: whole.kind, start: whole.start, end: whole.end, startLine: whole.startLine }, { kind: "file", start: 0, end: FILE.length, startLine: 1 });
    const from = FILE.indexOf("local function helper");
    const to = FILE.indexOf("end\n", from) + 3;
    const sel = makeTarget("main.lua", FILE, { start: from, end: to });
    assert.equal(sel.kind, "selection");
    assert.equal(sel.code, "local function helper(x)\n  return x + 1\nend");
    assert.equal(sel.startLine, 11);
    assert.equal(sel.endLine, 13);
    assert.match(sel.before, /return false/);
    assert.equal(sel.after, "");
  });
  it("treats a selection of only whitespace as no selection", () => {
    assert.equal(makeTarget("a.lua", "a\n\n\nb", { start: 1, end: 4 }).kind, "file");
  });
});

describe("validateTask", () => {
  it("requires code for code actions, and an instruction for Modify and Generate", () => {
    assert.match(validateTask(task({ action: "fix" }, "  \n"))!, /no code/);
    assert.match(validateTask(task({ action: "modify" }))!, /what should change/i);
    assert.match(validateTask(task({ action: "generate" }))!, /Describe the script/);
    assert.equal(validateTask(task({ action: "generate", instruction: "a daily reward" }, "")), null);
    assert.equal(validateTask(task({ action: "optimize" })), null);
  });
  it("refuses code that is too long to send", () => {
    assert.match(validateTask(task({ action: "explain" }, "x".repeat(MAX_AI_CODE_CHARS + 1)))!, /too long/);
  });
});

describe("request text", () => {
  const from = FILE.indexOf("onPlayerCommandCallback");
  const to = FILE.indexOf("end)", from) + 4;
  it("a selection is sent as the script with the surrounding code marked as reference only", () => {
    const t = task({ action: "optimize" }, FILE, { start: from, end: to });
    const text = buildRequestText(t);
    assert.match(text, /SELECTED PART \(lines 3-9\) of the file "main\.lua"/);
    assert.match(text, /```text\n--- before the selection ---\nlocal greeting = "Hello"/);
    assert.match(text, /--- after the selection ---\nlocal function helper/);
    const lua = /```lua\n([\s\S]*?)\n```/.exec(text)!;
    assert.equal(lua[1], t.target.code, "only the selection is in the lua block (the server treats it as the original script)");
    assert.doesNotMatch(lua[1]!, /helper/);
  });
  it("a whole file is sent as the lua block with no selection wording", () => {
    const text = buildRequestText(task({ action: "refactor" }));
    assert.doesNotMatch(text, /SELECTED PART/);
    assert.match(text, /```lua\nlocal greeting/);
  });
  it("Fix includes the local syntax problems that fall inside the selection, with line numbers relative to it", () => {
    const t = task({ action: "fix", syntaxProblems: [{ line: 5, column: 3, message: "boom", severity: "error" }, { line: 12, column: 1, message: "zzz-elsewhere", severity: "error" }] }, FILE, { start: from, end: to });
    const text = buildRequestText(t);
    assert.match(text, /- line 3: boom/);
    assert.doesNotMatch(text, /zzz-elsewhere/);
  });
  it("Fix on a whole file also carries the still-current documentation findings", () => {
    const check = { syntax: { ok: true }, stats: { lines: 1, functions: 0, calls: 0 }, apiUses: [], findings: [{ kind: "undocumented_api", severity: "error", message: "getplayer is not documented", line: 3, name: "getplayer" }], preservation: null, passed: false } as never;
    assert.match(buildRequestText(task({ action: "fix", docsCheck: check })), /getplayer is not documented/);
    assert.doesNotMatch(buildRequestText(task({ action: "fix", docsCheck: null })), /getplayer/);
  });
  it("Modify carries the instruction; Generate is only the user's description (no code block)", () => {
    assert.match(buildRequestText(task({ action: "modify", instruction: "log every command" })), /log every command/);
    assert.equal(buildRequestText(task({ action: "generate", instruction: "  a /hello command  " })), "a /hello command");
  });
  it("every action but Explain uses the generator (documentation always searched); Explain is a documentation-backed chat", () => {
    for (const def of WORKSPACE_AI_ACTIONS) {
      const req = buildChatRequest(task({ action: def.id, instruction: "x" }), { provider: "groq", model: "m" });
      assert.equal(req.mode, def.id === "explain" ? "chat" : "generate", def.id);
      assert.equal(req.docs, def.id === "explain" ? true : undefined, def.id);
      assert.equal(req.messages.length, 1);
    }
    assert.deepEqual(Object.keys(buildChatRequest(task({ action: "fix" }))).sort(), ["messages", "mode"], "no provider or model: the saved defaults apply");
  });
});

describe("applying a result", () => {
  const from = FILE.indexOf("local function helper");
  const to = FILE.indexOf("end\n", from) + 3;
  const sel = task({ action: "optimize" }, FILE, { start: from, end: to });
  const whole = task({ action: "optimize" });

  it("offers replace for code actions and insert/replace for Generate", () => {
    assert.deepEqual(applyModes(sel), ["replace-selection", "insert"]);
    assert.deepEqual(applyModes(whole), ["replace-file", "insert"]);
    assert.deepEqual(applyModes(task({ action: "generate", instruction: "x" })), ["insert", "replace-file"]);
  });
  it("replaces only the selection", () => {
    const plan = planApply("replace-selection", FILE, sel, "local function helper(x) return x + 1 end", 0);
    assert.equal(plan.ok && plan.next, FILE.slice(0, from) + "local function helper(x) return x + 1 end" + FILE.slice(to));
  });
  it("refuses to replace when the code changed after the request", () => {
    const changed = FILE.replace("x + 1", "x + 2");
    const plan = planApply("replace-selection", changed, sel, "new", 0);
    assert.equal(plan.ok, false);
    assert.match(plan.ok ? "" : plan.error, /changed after the request/);
    assert.equal(planApply("replace-file", `${FILE}-- more`, whole, "new", 0).ok, false);
  });
  it("replaces the whole file and ends it with a newline", () => {
    const plan = planApply("replace-file", FILE, whole, "print(1)", 0);
    assert.deepEqual(plan.ok && [plan.start, plan.end, plan.next], [0, FILE.length, "print(1)\n"]);
  });
  it("inserts at the cursor on its own lines, and Generate may insert into a changed file", () => {
    const gen = task({ action: "generate", instruction: "x" });
    const mid = planApply("insert", "a = 1\nb = 2\n", gen, "print('x')", 3);
    assert.equal(mid.ok && mid.next, "a =\nprint('x')\n\n 1\nb = 2\n", "a mid-line cursor gets the script on its own lines");
    const end = planApply("insert", "a = 1\n", gen, "print('x')\n", 6);
    assert.equal(end.ok && end.next, "a = 1\nprint('x')\n");
    assert.equal(planApply("insert", "", gen, "print(1)", 99).ok, true);
  });
});

describe("line diff", () => {
  it("finds added, removed and unchanged lines", () => {
    const ops = diffLines("a\nb\nc\nd", "a\nc\nd\ne");
    assert.deepEqual(ops.map((o) => `${o.type[0]}:${o.text}`), ["s:a", "d:b", "s:c", "s:d", "a:e"]);
    assert.deepEqual(diffStats(ops), { added: 1, removed: 1, unchanged: 3 });
  });
  it("handles empty sides and identical text", () => {
    assert.deepEqual(diffLines("", "x\ny").map((o) => o.type), ["add", "add"]);
    assert.deepEqual(diffLines("x", "").map((o) => o.type), ["del"]);
    assert.deepEqual(diffStats(diffLines("same\ntext", "same\ntext")), { added: 0, removed: 0, unchanged: 2 });
  });
  it("folds long unchanged runs", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const after = before.replace("line15", "CHANGED");
    const folded = foldDiff(diffLines(before, after), 2);
    assert.deepEqual(folded.filter((o) => o.type === "skip"), [{ type: "skip", count: 13 }, { type: "skip", count: 12 }]);
    assert.equal(folded.length, 2 + 2 + 1 + 1 + 2, "2 skips + 2 context + removed + added + 2 context");
  });
});

describe("find and replace helpers (basic editor)", () => {
  it("finds, picks, replaces and locates", () => {
    assert.deepEqual(findAll("aAa", "a"), [0, 1, 2]);
    assert.deepEqual(findAll("aAa", "a", true), [0, 2]);
    assert.deepEqual(findAll("abc", ""), []);
    assert.deepEqual(findAll("aaaa", "aa"), [0, 2], "non-overlapping");
    assert.equal(pickMatch([2, 8], 3), 8);
    assert.equal(pickMatch([2, 8], 9), 2, "wraps");
    assert.equal(pickMatch([2, 8], 8, true), 2);
    assert.equal(pickMatch([2, 8], 2, true), 8, "wraps backwards");
    assert.equal(pickMatch([], 0), null);
    assert.deepEqual(replaceAll("a-b-A", "a", "xx"), { text: "xx-b-xx", count: 2 });
    assert.deepEqual(replaceAll("none", "q", "z"), { text: "none", count: 0 });
    assert.deepEqual(positionOf("ab\ncd", 4), { line: 2, column: 2 });
    assert.equal(offsetOfLine("ab\ncd\nef", 3, 2), 7);
    assert.equal(offsetOfLine("ab", 9), 2);
  });
});

// ---- the real round trip ----

let be: Backend;
const { db } = generatorDb();
before(async () => void (be = await startBackend({ docsDb: db })));
after(async () => {
  await be.close();
});
beforeEach(() => be.reset());
afterEach(() => assert.equal(be.gemini.pending() + be.groq.pending(), 0, "leaked override"));

const client = () => createAiClient({ fetch: be.fetch, streamIdleMs: 3000 });
const reply = (code: string) => `## Script name\n\`demo.lua\`\n\n## Complete Lua code\n\n\`\`\`lua\n${code}\n\`\`\`\n\n## Known limitations\nNone.`;
const sysOf = () => lastGroqMessages(be.groq)[0]!.content;
const userOf = () => lastGroqMessages(be.groq).at(-1)!.content;
const GROQ = { provider: "groq" as const, model: "llama-demo-70b" };

describe("AI round trip through the real backend", () => {
  const from = FILE.indexOf("onPlayerCommandCallback");
  const to = FILE.indexOf("end)", from) + 4;

  it("Modify on a selection: documentation is retrieved and put in the prompt, the selection is the script, the result is checked against it", async () => {
    await be.configure(GROQ);
    const t = task({ action: "modify", instruction: "also log the command to the console" }, FILE, { start: from, end: to });
    const newCode = t.target.code.replace("return true", 'print("handled")\n    return true');
    be.groq.setReply([reply(newCode)]);
    const seen: string[] = [];
    const result = await runAiTask(client(), t, { onText: (s) => seen.push(s) });
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.script, newCode);
    assert.equal(result.incomplete, false);
    assert.ok(seen.length >= 1 && seen.at(-1) === result.text, "streamed text reached the callback");
    // documentation retrieval happened and its excerpts are in the system prompt the provider received
    assert.equal(result.retrieval?.status, "used");
    assert.ok((result.retrieval?.sectionsSent ?? 0) > 0);
    assert.match(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.match(userOf(), /Indexed GTPS Cloud documentation excerpts/);
    assert.match(userOf(), /<<<SOURCE-[0-9a-f]+ n=1/, "numbered documentation excerpts are in the prompt the provider received");
    assert.match(userOf(), /Signature: onPlayerCommandCallback/, "the documented API entry for the callback the selection uses");
    // the selection (not the whole file) was sent as the script
    const asked = userOf().slice(userOf().indexOf("The code below is a SELECTED PART"));
    assert.match(asked, /SELECTED PART \(lines 3-9\)/);
    assert.doesNotMatch(asked.replace(/```text[\s\S]*?```/, ""), /local function helper/);
    // the backend's check of the result: it knows this is a modification
    assert.ok(result.check);
    assert.ok(result.check!.preservation, "the selection was compared with the result");
    assert.equal(result.check!.syntax.ok, true);
    assert.equal(result.provider, "groq");
  });

  it("Explain is a documentation-backed chat answer, not a generator run, and produces no script", async () => {
    await be.configure(GROQ);
    be.groq.setReply(["It registers a command handler [1]."]);
    const result = await runAiTask(client(), task({ action: "explain" }));
    assert.equal(result.ok && result.script, null);
    assert.equal(result.ok && result.check, null);
    assert.equal(result.ok && result.retrieval?.status, "used");
    assert.doesNotMatch(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.match(userOf(), /Explain this script/);
    assert.match(userOf(), /Indexed GTPS Cloud documentation excerpts/);
  });

  it("Generate from natural language searches the documentation for the request", async () => {
    await be.configure(GROQ);
    be.groq.setReply([reply('onPlayerCommandCallback(function(world, player, command, args)\n  return false\nend)')]);
    const result = await runAiTask(client(), task({ action: "generate", instruction: "Create a custom player command /hello" }, ""));
    assert.equal(result.ok && result.retrieval?.status, "used");
    assert.match(sysOf(), /SCRIPT GENERATOR MODE/);
    assert.match(userOf(), /Indexed GTPS Cloud documentation excerpts/);
    assert.equal(userOf().includes("Create a custom player command /hello"), true);
    assert.equal(result.ok && result.check?.syntax.ok, true);
  });

  it("a script with a syntax error comes back with the error in its check, and the reply's syntax is flagged", async () => {
    await be.configure(GROQ);
    be.groq.setReply([reply("if true then\n  print(1)")]);
    const result = await runAiTask(client(), task({ action: "optimize" }));
    assert.equal(result.ok && result.check?.syntax.ok, false);
    assert.equal(result.ok && result.check?.passed, false);
    assert.equal(checkSyntax(result.ok ? (result.script ?? "") : "").clean, false, "the editor's own check agrees");
  });

  it("a reply cut off inside the code block is reported as incomplete", async () => {
    await be.configure(GROQ);
    be.groq.setReply(["## Complete Lua code\n\n```lua\nprint(1)\nprint("]);
    const result = await runAiTask(client(), task({ action: "optimize" }));
    assert.equal(result.ok && result.incomplete, true);
  });

  it("reports provider errors and invalid tasks without throwing", async () => {
    await be.configure(GROQ);
    be.groq.queue({ status: 429, headers: { "retry-after": "90" }, body: JSON.stringify({ error: { message: "slow down" } }) }); // a long Retry-After: the backend does not wait and retry
    const limited = await runAiTask(client(), task({ action: "optimize" }));
    assert.equal(limited.ok, false);
    assert.equal(!limited.ok && limited.error.kind, "rate_limited");

    const none = await runAiTask(client(), task({ action: "modify" }));
    assert.equal(!none.ok && none.error.message.length > 0, true, "invalid task is rejected before any request");
  });

  it("cancelling keeps the text received so far", async () => {
    await be.configure(GROQ);
    be.groq.queue({ stream: [Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" } }] })}\n\n`)], holdOpen: true });
    const controller = new AbortController();
    const pending = runAiTask(client(), task({ action: "optimize" }), { signal: controller.signal, onText: () => controller.abort() });
    const cancelled = await pending;
    assert.equal(!cancelled.ok && cancelled.error.kind, "cancelled");
    assert.equal(!cancelled.ok && cancelled.partial, "partial");
  });

  it("never sends the API key to the model or back to the client", async () => {
    await be.configure(GROQ);
    be.groq.setReply([reply("print(1)")]);
    const result = await runAiTask(client(), task({ action: "comments" }));
    const everything = JSON.stringify(result) + JSON.stringify(lastGroqMessages(be.groq));
    assert.equal(everything.includes(GROQ_KEY), false);
    assert.equal(everything.includes(GEMINI_KEY), false);
  });

  it("every action exists with a label", () => {
    assert.deepEqual(WORKSPACE_AI_ACTIONS.map((a) => a.id), ["explain", "fix", "optimize", "comments", "refactor", "modify", "generate"]);
    assert.equal(actionDef("generate").needsCode, false);
  });
});
