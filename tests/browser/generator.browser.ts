/**
 * The Script Generator in real Chromium: the real React components, the real chat engine, the real AI backend
 * (request analysis, multi-topic retrieval over SQLite, script check) in front of local fake Gemini/Groq servers.
 * Stand-ins: zustand (not installed here), next/navigation, lucide icons and
 * Tailwind layout utilities. Run with `npm run test:browser`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";

import { startBackend, lastGroqMessages, type Backend } from "../support/backend";
import { generatorDb } from "../support/gtps-lua-fixture";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

let be: Backend;
const docs = generatorDb();
let site: TestSite;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

before(async () => {
  be = await startBackend({ docsDb: docs.db });
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/chat-app.tsx")), [(req, res) => be.http(req, res)], '<div id="root"></div>', readFileSync(join(ROOT, "tests/browser/support/layout.css"), "utf8") + readFileSync(join(ROOT, "tests/browser/support/workspace.css"), "utf8"));
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.close();
  await be.close();
});
beforeEach(async () => {
  await be.reset();
  errors.length = 0;
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  context.setDefaultTimeout(5000);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
});
afterEach(async () => {
  await context.close();
  assert.deepEqual(errors, [], "no script errors in the page");
  assert.equal(be.gemini.pending() + be.groq.pending(), 0, "leaked override");
});

const SCRIPT = 'onPlayerCommandCallback(function(world, player, command, args)\n  if command == "hello" then\n    player:onConsoleMessage("Hello " .. player:getName())\n    return true\n  end\n  return false\nend)';
const reply = (code: string) => `## Script name\n\`hello_command.lua\`\n\n## Purpose\nGreets players.\n\n## Complete Lua code\n\n\`\`\`lua\n${code}\n\`\`\`\n\n## Usage instructions\nType /hello.\n\n## Known limitations\nNone.`;
const partial = (text: string) => Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);

const open = async () => {
  await be.configure({ provider: "groq", model: "llama-demo-70b" });
  await page.goto(site.origin);
  await page.getByLabel("Message", { exact: true }).waitFor();
  await page.getByText("Loading chat…").waitFor({ state: "detached" });
  await page.locator("#model-select").waitFor();
};
const goGenerator = async () => {
  await page.getByRole("button", { name: "Go to generator" }).click();
  await page.getByTestId("mode-badge").waitFor();
};
const composer = () => page.getByLabel("Message", { exact: true });
const send = async (text: string) => {
  await composer().fill(text);
  await composer().press("Enter");
};
const finished = () => page.waitForFunction(() => {
  const users = document.querySelectorAll('article[data-role="user"]').length;
  const replies = [...document.querySelectorAll('article[data-role="assistant"]')];
  const last = replies[replies.length - 1];
  return users > 0 && replies.length === users && last?.getAttribute("data-status") !== "streaming" && !document.querySelector('[aria-label="Stop generating"]');
});
const generate = async (request: string, code: string) => {
  be.groq.setReply([reply(code)]);
  await send(request);
  await finished();
};
const lastReply = () => page.locator('article[data-role="assistant"]').last();
const sentToProvider = () => lastGroqMessages(be.groq);

describe("generator page", () => {
  it("shows the generator welcome screen with the seven script types, and picking one fills the composer", async () => {
    await open();
    await goGenerator();
    await page.getByText("What should the script do?").waitFor();
    assert.equal(await page.getByTestId("mode-badge").innerText(), "Script Generator");
    const count = await page.evaluate(() => (window as unknown as { __generatorPromptCount: number }).__generatorPromptCount);
    assert.equal(count, 7);
    for (const label of ["Custom player command", "Daily reward system", "NPC shop", "Automatic event", "Player moderation system", "Mailbox reward system", "Custom item interaction"]) {
      assert.equal(await page.getByRole("button", { name: label, exact: true }).count(), 1, label);
    }
    assert.match(await page.getByTestId("ctx-search").innerText(), /always on/);
    assert.equal(await page.getByLabel("Search documentation before answering").count(), 0, "no off switch in generator mode");
    await page.getByRole("button", { name: "Daily reward system", exact: true }).click();
    assert.match(await composer().inputValue(), /daily reward system/);
    assert.equal(await page.locator('article[data-role="user"]').count(), 0, "picking does not send");
    assert.equal(await composer().getAttribute("placeholder"), "Describe the script you want, or paste one to modify");
  });

  it("generating: documentation reaches the model, the report shows real counts, the check passes, sources are listed", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello that greets the player", SCRIPT);

    const prompt = sentToProvider();
    assert.match(prompt[0]!.content, /SCRIPT GENERATOR MODE/);
    const asked = prompt[1]!.content;
    const searched = Number(/Documentation topics searched \((\d+)\)/.exec(asked)![1]);
    assert.match(asked, /<<<SOURCE-[0-9a-f]+ n=1/);

    const report = page.getByTestId("generation-report");
    await report.waitFor();
    assert.equal(await report.getByTestId("topic").count(), searched, "the report lists the topics the model was told about");
    assert.match(await report.getByTestId("analysis").innerText(), /Custom player command/);
    assert.equal(await page.getByTestId("script-check").getAttribute("data-passed"), "true");
    assert.match(await page.getByTestId("syntax-status").innerText(), /no syntax errors found/);
    assert.match(await page.getByTestId("api-summary").innerText(), /APIs used: 3 documented · 0 not in the documentation/);
    assert.equal(await page.getByTestId("api-use").filter({ hasText: "onPlayerCommandCallback" }).getAttribute("data-status"), "documented");
    assert.ok(await page.getByTestId("sources").count(), "documentation sources are listed");
    assert.equal(await page.getByTestId("script-actions").count(), 1);
    assert.equal(await page.getByTestId("history-generator-tag").count(), 1, "the history marks it as a script chat");
  });

  it("an invented method is reported, with the line and the problem", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /moon", "function onPlayerJoinWorld(w, p)\n  p:teleportToMoon()\nend");
    assert.equal(await page.getByTestId("script-check").getAttribute("data-passed"), "false");
    const findings = await page.getByTestId("finding").allInnerTexts();
    assert.ok(findings.some((f) => /teleportToMoon is not in the indexed GTPS documentation/.test(f) && /line 2/.test(f)), findings.join(" | "));
    assert.ok(findings.some((f) => /onPlayerJoinWorld.*no event or callback/.test(f)));
    assert.equal(await page.getByTestId("api-use").filter({ hasText: "teleportToMoon" }).getAttribute("data-status"), "undocumented");
  });

  it("a topic the documentation does not cover is shown as missing", async () => {
    await open();
    await goGenerator();
    await generate("Create an NPC shop that sells items for gems", 'local s = Shop:create("A")');
    assert.match(await page.getByTestId("missing-topics").innerText(), /Dialogs and menus/);
  });
});

describe("script actions", () => {
  it("Copy puts only the Lua code on the clipboard", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    await page.getByRole("button", { name: "Copy script" }).click();
    await page.getByText("Copied", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), SCRIPT);
  });

  it("Download .lua saves the code under the name given in the reply", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download hello_command.lua" }).click()]);
    assert.equal(download.suggestedFilename(), "hello_command.lua");
    const path = await download.path();
    assert.equal(readFileSync(path, "utf8"), `${SCRIPT}\n`);
  });

  it("Open in Lua Workspace adds the file (unique names) and goes to the workspace", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    await page.getByRole("button", { name: "Open in Lua Workspace" }).click();
    await page.locator('[data-testid="file-row"][data-name="hello_command.lua"]').waitFor();
    assert.equal(await page.getByTestId("basic-editor").inputValue(), SCRIPT);
    assert.equal(await page.getByRole("tab", { name: /hello_command\.lua/ }).getAttribute("aria-selected"), "true");
    assert.equal(await page.locator('[data-testid="file-row"]').count(), 2, "the starter file and the new one");

    await page.getByRole("button", { name: "Go to generator" }).click();
    await page.getByRole("button", { name: "Open in Lua Workspace" }).click();
    await page.locator('[data-testid="file-row"][data-name="hello_command_2.lua"]').waitFor();
  });

  it("Explain Code is a documentation-backed answer, not a new script", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    be.groq.setReply(["It registers a command handler [1]."]);
    await page.getByRole("button", { name: "Explain Code" }).click();
    await finished();
    const sys = sentToProvider()[0]!.content;
    assert.doesNotMatch(sys, /SCRIPT GENERATOR MODE/);
    assert.ok(sentToProvider().at(-1)!.content.includes(SCRIPT), "the whole script was sent");
    assert.equal(await page.locator('article[data-role="assistant"]').count(), 2);
    assert.equal(await lastReply().getByTestId("script-actions").count(), 0, "an explanation has no script actions");
    assert.equal(await lastReply().getByTestId("generation-report").count(), 0);
  });

  it("Optimize and Add Comments go through the generator and the report says what was preserved", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    const commented = `-- greets players\n${SCRIPT}`;
    be.groq.setReply([reply(commented)]);
    await page.getByRole("button", { name: "Add Comments" }).click();
    await finished();
    assert.match(sentToProvider()[0]!.content, /SCRIPT GENERATOR MODE/);
    assert.ok(sentToProvider().at(-1)!.content.includes(SCRIPT));
    const pres = lastReply().getByTestId("preservation");
    await pres.waitFor();
    assert.match(await pres.innerText(), /1 unchanged · 0 changed · 0 removed · 0 added/, "a comment does not change the code");

    be.groq.setReply([reply('logToConsole("dropped everything")')]);
    await lastReply().getByRole("button", { name: "Optimize" }).click();
    await finished();
    const text = await lastReply().getByTestId("preservation").innerText();
    assert.match(text, /0 unchanged · 0 changed · 1 removed · 1 added/);
    assert.match(text, /Removed: call onPlayerCommandCallback/);
  });

  it("Modify Script asks what to change and sends it with the complete script", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    await page.getByRole("button", { name: "Modify Script" }).click();
    const submit = page.getByRole("button", { name: "Modify", exact: true });
    assert.equal(await submit.isDisabled(), true, "needs an instruction");
    await page.getByLabel("What should change in this script?").fill("log every use of the command");
    be.groq.setReply([reply(SCRIPT.replace('if command == "hello" then', 'if command == "hello" then\n    logToConsole("used")'))]);
    await submit.click();
    await finished();
    const sent = sentToProvider().at(-1)!.content;
    assert.match(sent, /Modify this script: log every use of the command/);
    assert.ok(sent.includes(SCRIPT));
    assert.match(await lastReply().getByTestId("analysis").innerText(), /modification of an existing script/);
    assert.match(await lastReply().getByTestId("preservation").innerText(), /0 unchanged · 1 changed/);
  });

  it("Fix Errors sends the problems the check found, and the fixed script passes", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /moon", 'local p = getPlayer("a")\np:teleportToMoon()');
    assert.equal(await page.getByTestId("script-check").getAttribute("data-passed"), "false");
    be.groq.setReply([reply('local p = getPlayer("a")\np:onConsoleMessage("hi")')]);
    await page.getByRole("button", { name: "Fix Errors" }).click();
    await finished();
    const sent = sentToProvider().at(-1)!.content;
    assert.match(sent, /documentation check found these problems/);
    assert.match(sent, /p:teleportToMoon is not in the indexed GTPS documentation/);
    assert.equal(await lastReply().getByTestId("script-check").getAttribute("data-passed"), "true");
  });

  it("Generate Alternative asks for a new script (not a modification)", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    be.groq.setReply([reply('onPlayerCommandCallback(function(world, player, command, args)\n  return false\nend)')]);
    await page.getByRole("button", { name: "Generate Alternative" }).click();
    await finished();
    assert.match(sentToProvider().at(-1)!.content, /alternative implementation/);
    assert.match(await lastReply().getByTestId("analysis").innerText(), /new script/);
    assert.equal(await lastReply().getByTestId("preservation").count(), 0);
  });

  it("request actions are disabled while a reply is being written", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    be.groq.queue({ stream: [partial("working on it")], holdOpen: true });
    await page.getByRole("button", { name: "Optimize" }).click();
    await page.getByLabel("Stop generating").waitFor();
    assert.equal(await page.getByRole("button", { name: "Refactor" }).first().isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Open in Lua Workspace" }).first().isDisabled(), false, "local actions stay available");
    await page.getByLabel("Stop generating").click();
    await finished();
  });
});

describe("modes and provider switching", () => {
  it("Chat and Generator keep separate conversations, and the history opens each in its own mode", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    await page.getByRole("button", { name: "Go to chat", exact: true }).click();
    await page.getByText("What are you building today?").waitFor();
    assert.equal(await page.getByTestId("mode-badge").count(), 0);
    be.groq.setReply(["Hello!"]);
    await send("hi there");
    await finished();
    assert.doesNotMatch(sentToProvider()[0]!.content, /SCRIPT GENERATOR MODE/);
    assert.equal(await page.getByTestId("generation-report").count(), 0);

    await page.getByRole("button", { name: /Create a custom player command/ }).first().click();
    await page.getByTestId("mode-badge").waitFor();
    assert.equal(await page.getByTestId("generation-report").count(), 1, "the generator conversation is back with its report");
    await page.getByRole("button", { name: "hi there", exact: true }).click();
    await page.getByTestId("mode-badge").waitFor({ state: "detached" });
    assert.equal(await page.locator('article[data-role="user"] [data-testid="user-text"]').first().innerText(), "hi there");
  });

  it("switching to Gemini in a generator chat keeps the workflow and the check", async () => {
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    await be.configure({ provider: "gemini", model: "gemini-alpha" });
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    await page.locator("#provider-select").selectOption("gemini");
    await page.waitForFunction(() => (document.querySelector("#provider-select") as HTMLSelectElement).value === "gemini");
    be.gemini.setReply([reply(SCRIPT)]);
    await send("Create a mailbox reward system");
    await finished();
    const req = be.gemini.requests.filter((r) => /generatecontent/i.test(r.url)).at(-1)!;
    assert.match(String(req.body), /SCRIPT GENERATOR MODE/);
    assert.match(String(req.body), /Verified API reference/);
    assert.equal(await lastReply().getByTestId("script-check").getAttribute("data-passed"), "true");
    assert.match(await lastReply().locator('[data-testid="assistant-label"]').innerText(), /Gemini/);
  });

  it("the report and the check survive a page reload", async () => {
    await open();
    await goGenerator();
    await generate("Create a custom player command /hello", SCRIPT);
    await page.reload();
    await page.getByLabel("Message", { exact: true }).waitFor();
    await page.getByText("Loading chat…").waitFor({ state: "detached" });
    await goGenerator();
    await page.getByTestId("script-check").waitFor();
    assert.equal(await page.getByTestId("script-check").getAttribute("data-passed"), "true");
    assert.equal(await page.getByTestId("script-actions").count(), 1);
  });
});
