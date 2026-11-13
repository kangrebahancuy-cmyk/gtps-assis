/**
 * The chat UI in real Chromium: the real React components, the real chat
 * engine and IndexedDB, and the real AI backend in front of local fake
 * Gemini/Groq servers. Layout utilities from Tailwind are replaced by a few
 * stand-in CSS rules, so these tests check behaviour, not appearance.
 * Run with `npm run test:browser`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";

import { groqEvents } from "../ai-fakes";
import { startBackend, type Backend } from "../support/backend";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

let be: Backend;
let site: TestSite;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

before(async () => {
  be = await startBackend();
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/chat-app.tsx")), [(req, res) => be.http(req, res)], '<div id="root"></div>', readFileSync(join(ROOT, "tests/browser/support/layout.css"), "utf8"));
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

const open = async (p: Page = page) => {
  await p.goto(site.origin);
  await p.getByLabel("Message", { exact: true }).waitFor();
  await p.getByText("Loading chat…").waitFor({ state: "detached" });
};
const configured = async (target = { provider: "groq" as const, model: "llama-demo-70b" }) => {
  await be.configure(target);
  await open();
  await page.locator("#model-select").waitFor();
};
const composer = () => page.getByLabel("Message", { exact: true });
const send = async (text: string) => {
  await composer().fill(text);
  await composer().press("Enter");
};
const assistantTexts = () => page.locator('article[data-role="assistant"] [data-testid="assistant-text"]').allInnerTexts();
/** Waits until the provider selector shows this value (the UI updates a moment after a click). */
const providerIs = (value: string) => page.waitForFunction((v) => (document.querySelector("#provider-select") as HTMLSelectElement | null)?.value === v, value);
const welcomeShown = () => page.getByText("What are you building today?").waitFor();
const userTexts = () => page.locator('article[data-role="user"] [data-testid="user-text"]').allTextContents();
/** Every question has its reply, the last reply is no longer streaming, and the Stop button is gone. */
const finished = () => page.waitForFunction(() => {
  const users = document.querySelectorAll('article[data-role="user"]').length;
  const replies = [...document.querySelectorAll('article[data-role="assistant"]')];
  const last = replies[replies.length - 1];
  return users > 0 && replies.length === users && last?.getAttribute("data-status") !== "streaming" && !document.querySelector('[aria-label="Stop generating"]');
});
const sidebarChats = () => page.getByRole("list", { name: "Chats" }).locator("li").allInnerTexts();
const atBottom = () => page.getByTestId("message-scroller").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4);
const partial = (text: string) => Buffer.from(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);

describe("welcome screen and setup", () => {
  it("shows the example prompts and says that no provider is connected", async () => {
    await open();
    await page.getByText("What are you building today?").waitFor();
    assert.equal(await page.getByRole("button", { name: /Create a custom player command/ }).count(), 1);
    await page.getByText(/No AI provider is connected yet/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Send message" }).isDisabled(), true);
    await composer().fill("hello");
    await composer().press("Enter");
    assert.equal(await userTexts().then((t) => t.length), 0, "nothing is sent without a provider");
  });
  it("picking an example fills the composer (and does not send it)", async () => {
    await configured();
    await page.getByRole("button", { name: /Create a reward system/ }).click();
    assert.equal(await composer().inputValue(), "Create a reward system.");
    assert.equal(await composer().evaluate((el) => document.activeElement === el), true, "composer is focused");
    assert.equal(await userTexts().then((t) => t.length), 0);
  });
});

describe("chatting", () => {
  it("sends with Enter, streams the reply, shows provider and model, and puts the chat in the history", async () => {
    await configured();
    await send("Create a custom player command.");
    await finished();
    assert.deepEqual(await userTexts(), ["Create a custom player command."]);
    assert.deepEqual(await assistantTexts(), ["Hello wörld ✓"]);
    assert.equal(await page.getByTestId("assistant-label").innerText(), "Groq · llama-demo-70b");
    assert.equal(await composer().inputValue(), "", "composer cleared");
    assert.deepEqual(await sidebarChats(), ["Create a custom player command."]);
    assert.equal(await page.locator("h1").innerText(), "Create a custom player command.");
  });
  it("Shift+Enter adds a line instead of sending, and multi-line text is kept", async () => {
    await configured();
    await composer().fill("line one");
    await composer().press("Shift+Enter");
    await composer().pressSequentially("line two");
    assert.equal(await composer().inputValue(), "line one\nline two");
    assert.equal(await userTexts().then((t) => t.length), 0);
    await composer().press("Enter");
    await finished();
    assert.deepEqual(await userTexts(), ["line one\nline two"]);
  });
  it("the composer grows with its text, up to a limit", async () => {
    await configured();
    const height = () => composer().evaluate((el) => el.getBoundingClientRect().height);
    const small = await height();
    await composer().fill(Array.from({ length: 6 }, (_, i) => `line ${i}`).join("\n"));
    const larger = await height();
    await composer().fill(Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n"));
    const capped = await height();
    assert.ok(larger > small, `${larger} > ${small}`);
    assert.ok(capped <= 224 && capped >= larger, `capped at ${capped}`);
  });
  it("shows a loading state before the first text, then the text while streaming, with Stop instead of Send", async () => {
    await configured();
    be.groq.queue({ hang: true });
    await send("slow one");
    await page.getByText("Generating a reply").waitFor();
    assert.equal(await page.getByRole("button", { name: "Stop generating" }).count(), 1);
    assert.equal(await page.getByRole("button", { name: "Send message" }).count(), 0);
    await page.getByRole("button", { name: "Stop generating" }).click();
    await page.getByText("Generation stopped.").waitFor();
  });
  it("Stop keeps the partial text; Escape also stops; the chat continues afterwards", async () => {
    await configured();
    be.groq.queue({ stream: [partial("half an ans")], holdOpen: true });
    await send("tell me");
    await page.getByText("half an ans").waitFor();
    await composer().press("Escape");
    await page.getByText("Generation stopped.").waitFor();
    assert.deepEqual(await assistantTexts(), ["half an ans"]);
    assert.equal(await page.getByRole("button", { name: "Send message" }).count(), 1);
    be.groq.setReply(["go on then"]);
    await send("continue");
    await finished();
    assert.deepEqual(await assistantTexts(), ["half an ans", "go on then"]);
  });
  it("renders Markdown and highlights Lua code, with a working copy button for the code", async () => {
    await configured();
    be.groq.setReply(["Here is **bold** text and `inline`:\n\n```lua\n-- say hi\nlocal x = 1\nprint(\"hi\", x)\n```\n\n- one\n- two\n"]);
    await send("show code");
    await finished();
    const reply = page.locator('[data-testid="assistant-text"]');
    assert.equal(await reply.locator("strong").innerText(), "bold");
    assert.equal(await reply.locator("li").count(), 2);
    assert.equal(await reply.locator('[data-token="keyword"]').first().innerText(), "local");
    assert.equal(await reply.locator('[data-token="comment"]').first().innerText(), "-- say hi");
    assert.equal(await reply.locator('[data-token="string"]').count() >= 1, true);
    await reply.getByRole("button", { name: "Copy code" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '-- say hi\nlocal x = 1\nprint("hi", x)');
  });
  it("does not render HTML from the model as HTML", async () => {
    await configured();
    be.groq.setReply(['<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> [bad](javascript:alert(1))']);
    await send("xss?");
    await finished();
    assert.equal(await page.evaluate(() => (window as any).__pwned), undefined);
    assert.equal(await page.locator('[data-testid="assistant-text"] img, [data-testid="assistant-text"] script').count(), 0);
    assert.equal(await page.locator('[data-testid="assistant-text"] a[href^="javascript"]').count(), 0);
  });
  it("copies the response and the user's message", async () => {
    await configured();
    be.groq.setReply(["copy **this**"]);
    await send("my question");
    await finished();
    await page.getByRole("button", { name: "Copy response" }).click();
    await page.getByRole("button", { name: "Copy response" }).getByText("Copied").waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "copy **this**", "the Markdown source is copied");
    await page.getByRole("button", { name: "Copy message" }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "my question");
  });
});

describe("regenerate and edit", () => {
  it("regenerates the last reply", async () => {
    await configured();
    be.groq.setReply(["first take"]);
    await send("q");
    await finished();
    be.groq.setReply(["second take"]);
    await page.getByRole("button", { name: "Regenerate response" }).click();
    await page.getByText("second take").waitFor();
    await finished();
    assert.deepEqual(await assistantTexts(), ["second take"]);
    assert.equal(await page.getByRole("button", { name: "Regenerate response" }).count(), 1, "only the last reply offers it");
  });
  it("only the last reply can be regenerated", async () => {
    await configured();
    await send("one");
    await finished();
    await send("two");
    await finished();
    assert.equal(await page.getByRole("button", { name: "Regenerate response" }).count(), 1);
  });
  it("edits a user message: later messages are removed and the edited text is answered", async () => {
    await configured();
    for (const q of ["original", "second", "third"]) {
      be.groq.setReply([`reply to ${q}`]);
      await send(q);
      await finished();
    }
    be.groq.setReply(["reply to edit"]);
    await page.locator('article[data-role="user"]').first().getByRole("button", { name: "Edit message" }).click();
    const box = page.getByLabel("Edit your message");
    assert.equal(await box.inputValue(), "original");
    await box.fill("edited text");
    await page.getByRole("button", { name: "Save & submit" }).click();
    await page.getByText("reply to edit").waitFor();
    await finished();
    assert.deepEqual(await userTexts(), ["edited text"]);
    assert.deepEqual(await assistantTexts(), ["reply to edit"]);
    assert.equal(await page.getByText("edited", { exact: true }).count(), 1);
    assert.deepEqual(await sidebarChats(), ["edited text"]);
  });
  it("cancelling an edit changes nothing; Ctrl+Enter submits; Escape cancels", async () => {
    await configured();
    await send("keep");
    await finished();
    const edit = () => page.getByRole("button", { name: "Edit message" }).click();
    await edit();
    await page.getByLabel("Edit your message").fill("discard");
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.deepEqual(await userTexts(), ["keep"]);
    await edit();
    await page.getByLabel("Edit your message").press("Escape");
    assert.deepEqual(await userTexts(), ["keep"]);
    be.groq.setReply(["via shortcut"]);
    await edit();
    await page.getByLabel("Edit your message").fill("changed");
    await page.getByLabel("Edit your message").press("Control+Enter");
    await page.getByText("via shortcut").waitFor();
    assert.deepEqual(await userTexts(), ["changed"]);
  });
  it("edit is unavailable while a reply is being generated", async () => {
    await configured();
    be.groq.queue({ hang: true });
    await send("q");
    await page.getByText("Generating a reply").waitFor();
    assert.equal(await page.getByRole("button", { name: "Edit message" }).isDisabled(), true);
    await page.getByRole("button", { name: "Stop generating" }).click();
  });
});

describe("model selector", () => {
  it("lists the providers and only chat-capable models, from the live lists", async () => {
    await configured();
    assert.deepEqual(await page.locator("#provider-select option").allInnerTexts(), ["Google Gemini", "Groq"]);
    const groq = await page.locator("#model-select option").allInnerTexts();
    assert.deepEqual(groq.sort(), ["llama-demo-70b", "qwen-coder-demo"].sort().map((id) => groq.find((t) => t.includes(id)) ?? id));
    assert.equal(groq.some((t) => /whisper|retired/.test(t)), false);
    await page.locator("#provider-select").selectOption("gemini");
    const gemini = await page.locator("#model-select option").allInnerTexts();
    assert.equal(gemini.some((t) => t.includes("gemini-alpha")), true);
    assert.equal(gemini.some((t) => /embedder/i.test(t)), false);
  });
  it("switching to Gemini and back sends each message to the chosen provider, labelled on the reply", async () => {
    await configured();
    await send("to groq");
    await finished();
    await page.locator("#provider-select").selectOption("gemini");
    assert.equal(await page.locator("#model-select").inputValue(), "gemini-alpha");
    await send("to gemini");
    await finished();
    await page.locator("#model-select").selectOption("gemini-beta-flash");
    await send("to flash");
    await finished();
    assert.deepEqual(await page.getByTestId("assistant-label").allInnerTexts(), ["Groq · llama-demo-70b", "Google Gemini · gemini-alpha", "Google Gemini · gemini-beta-flash"]);
    assert.equal(be.gemini.requests.filter((r) => r.url.includes(":streamGenerateContent")).length, 2);
    assert.ok(be.gemini.requests.some((r) => r.url.startsWith("/models/gemini-beta-flash:")));
  });
  it("remembers the model per conversation across chats and across a reload", async () => {
    await configured();
    await send("groq chat");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    await page.locator("#provider-select").selectOption("gemini");
    await send("gemini chat");
    await finished();
    await page.getByRole("button", { name: /groq chat/ }).first().click();
    await providerIs("groq");
    assert.equal(await page.locator("#model-select").inputValue(), "llama-demo-70b");
    await page.getByRole("button", { name: /gemini chat/ }).first().click();
    await providerIs("gemini");

    await open();
    await providerIs("gemini"); // the open chat and its model are restored
    await page.getByRole("button", { name: /groq chat/ }).first().click();
    await providerIs("groq");
  });
  it("tells the user when no provider is configured, and links to settings", async () => {
    await open();
    await page.getByRole("link", { name: /Connect a provider/ }).waitFor();
    assert.equal(await page.locator("#provider-select").count(), 0);
  });
  it("refresh model list picks up newly added keys", async () => {
    await open();
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    await page.getByRole("button", { name: "Retry" }).count(); // not shown: status is ready
    await open();
    await page.locator("#provider-select").waitFor();
    await page.getByRole("button", { name: "Refresh model list" }).click();
    await page.locator("#model-select").waitFor();
  });
});

describe("conversations, history and persistence", () => {
  it("keeps several conversations, switches between them, newest first", async () => {
    await configured();
    be.groq.setReply(["answer A"]);
    await send("topic A");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    await welcomeShown();
    be.groq.setReply(["answer B"]);
    await send("topic B");
    await finished();
    assert.deepEqual((await sidebarChats()).map((t) => t.split("\n")[0]), ["topic B", "topic A"]);
    await page.getByRole("button", { name: /topic A/ }).first().click();
    assert.deepEqual(await userTexts(), ["topic A"]);
    assert.deepEqual(await assistantTexts(), ["answer A"]);
  });
  it("survives a page reload: history, open chat, messages", async () => {
    await configured();
    be.groq.setReply(["persisted answer ✓"]);
    await send("persist me");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    await send("second chat");
    await finished();
    await page.getByRole("button", { name: /persist me/ }).first().click();
    await page.locator("h1", { hasText: "persist me" }).waitFor();
    await page.waitForTimeout(100); // the choice of open chat is stored a moment after the click

    await open();
    assert.deepEqual((await sidebarChats()).map((t) => t.split("\n")[0]), ["second chat", "persist me"]);
    assert.deepEqual(await userTexts(), ["persist me"], "the chat that was open is open again");
    assert.deepEqual(await assistantTexts(), ["persisted answer ✓"]);
    assert.equal(await page.locator("h1").innerText(), "persist me");
  });
  it("survives closing and restarting the browser", async () => {
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    const profile = mkdtempSync(join(tmpdir(), "gtps-chat-profile-"));
    try {
      const first = await chromium.launchPersistentContext(profile);
      const p1 = await first.newPage();
      await open(p1);
      be.groq.setReply(["still here after restart"]);
      await p1.getByLabel("Message", { exact: true }).fill("before restart");
      await p1.getByLabel("Message", { exact: true }).press("Enter");
      await p1.getByRole("button", { name: "Stop generating" }).waitFor({ state: "detached" });
      await p1.getByText("still here after restart").waitFor();
      await first.close();

      const second = await chromium.launchPersistentContext(profile);
      const p2 = await second.newPage();
      await open(p2);
      assert.deepEqual(await p2.locator('article[data-role="user"] [data-testid="user-text"]').allInnerTexts(), ["before restart"]);
      assert.deepEqual(await p2.locator('[data-testid="assistant-text"]').allInnerTexts(), ["still here after restart"]);
      assert.deepEqual((await p2.getByRole("list", { name: "Chats" }).locator("li").allInnerTexts()).map((t) => t.split("\n")[0]), ["before restart"]);
      await second.close();
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
  it("closing the page in the middle of a reply leaves the question and shows the reply as interrupted", async () => {
    await configured();
    be.groq.queue({ stream: [partial("cut off he")], holdOpen: true });
    await send("long question");
    await page.getByText("cut off he").waitFor();
    await page.waitForTimeout(700); // the partial text is saved every 400 ms
    await page.close();
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await open();
    await page.getByText(/reply was interrupted/).waitFor();
    assert.deepEqual(await userTexts(), ["long question"]);
    assert.deepEqual(await assistantTexts(), ["cut off he"]);
    be.groq.setReply(["complete now"]);
    await page.getByRole("button", { name: "Regenerate response" }).click();
    await page.getByText("complete now").waitFor();
  });
  it("searches titles and message text and clears the search", async () => {
    await configured();
    be.groq.setReply(["Use onPlayerChatCallback for that."]);
    await send("How do I react to chat?");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    be.groq.setReply(["Sure, here is a shop."]);
    await send("Make a shop");
    await finished();
    const search = page.getByLabel("Search chats");
    await search.fill("callback");
    await page.getByRole("list", { name: "Chats" }).getByText(/…?.*onPlayerChatCallback/).waitFor();
    const hits = await sidebarChats();
    assert.equal(hits.length, 1, "only the chat that matches is listed");
    assert.match(hits[0] ?? "", /^How do I react to chat\?/);
    assert.match(hits[0] ?? "", /Use onPlayerChatCallback for that\./, "the matching text is shown");
    await search.fill("zzzz");
    await page.getByText("No chats match your search.").waitFor();
    await search.fill("");
    await page.getByRole("button", { name: "Make a shop", exact: true }).waitFor();
    assert.equal((await sidebarChats()).length, 2);
  });
  it("renames a chat (Enter saves, Escape cancels, empty is refused) and keeps the name after reload", async () => {
    await configured();
    await send("auto title");
    await finished();
    await page.getByRole("button", { name: /Rename chat auto title/ }).click();
    await page.getByLabel("Chat title").fill("My reward script");
    await page.getByLabel("Chat title").press("Enter");
    await page.getByRole("button", { name: "My reward script", exact: true }).waitFor();
    assert.equal(await page.locator("h1").innerText(), "My reward script");

    await page.getByRole("button", { name: /Rename chat My reward script/ }).click();
    await page.getByLabel("Chat title").fill("never saved");
    await page.getByLabel("Chat title").press("Escape");
    assert.equal(await page.getByText("never saved").count(), 0);

    await page.getByRole("button", { name: /Rename chat My reward script/ }).click();
    await page.getByLabel("Chat title").fill("   ");
    await page.getByLabel("Chat title").press("Enter");
    await page.getByText("A chat title can't be empty.").waitFor();
    await page.getByLabel("Chat title").press("Escape");

    await send("another message");
    await finished();
    assert.equal(await page.locator("h1").innerText(), "My reward script", "a manual title is not replaced");
    await open();
    assert.equal(await page.locator("h1").innerText(), "My reward script");
  });
  it("deletes a chat after confirmation and keeps the others", async () => {
    await configured();
    await send("keep me");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    await send("delete me");
    await finished();
    await page.getByRole("button", { name: /Delete chat delete me/ }).click();
    await page.getByRole("button", { name: /Confirm delete delete me/ }).click();
    await page.getByRole("button", { name: /delete me/ }).waitFor({ state: "detached" });
    assert.deepEqual((await sidebarChats()).map((t) => t.split("\n")[0]), ["keep me"]);
    await welcomeShown(); // a fresh chat opens
    await open();
    assert.deepEqual((await sidebarChats()).map((t) => t.split("\n")[0]), ["keep me"], "the deletion is permanent");
  });
});

describe("export, import and clear", () => {
  it("exports the history, clears it, and imports it back", async () => {
    await configured();
    be.groq.setReply(["answer one"]);
    await send("question one");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    await page.locator("#provider-select").selectOption("gemini");
    be.gemini.setReply(["answer two"]);
    await send("question two");
    await finished();

    await page.getByRole("button", { name: "Go to chat settings" }).click();
    await page.getByTestId("history-counts").getByText(/2 chat\(s\), 4 message\(s\)/).waitFor();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export JSON" }).click()]);
    const dir = mkdtempSync(join(tmpdir(), "gtps-export-"));
    try {
      const path = join(dir, download.suggestedFilename());
      await download.saveAs(path);
      assert.match(download.suggestedFilename(), /^gtps-assistant-chats-\d{4}-\d{2}-\d{2}\.json$/);
      const exported = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual([exported.format, exported.conversations.length], ["gtps-assistant-chat-export", 2]);
      assert.deepEqual(exported.conversations.flatMap((c: any) => c.messages.map((m: any) => m.content)).sort(), ["answer one", "answer two", "question one", "question two"]);

      await page.getByRole("button", { name: "Clear all history" }).click();
      await page.getByRole("button", { name: "Yes, delete everything" }).click();
      await page.getByTestId("history-counts").getByText(/0 chat\(s\), 0 message\(s\)/).waitFor();
      assert.deepEqual(await sidebarChats(), []);
      await open();
      assert.deepEqual(await sidebarChats(), [], "cleared for good, also after a reload");

      await page.getByRole("button", { name: "Go to chat settings" }).click();
      await page.getByLabel("Import chat history file").setInputFiles(path);
      await page.getByTestId("history-counts").getByText(/2 chat\(s\), 4 message\(s\)/).waitFor();
      await page.getByRole("button", { name: "Go to chat", exact: true }).click();
      assert.deepEqual((await sidebarChats()).map((t) => t.split("\n")[0]), ["question two", "question one"]);
      await page.getByRole("button", { name: /question two/ }).first().click();
      await page.getByText("answer two").waitFor();
      assert.deepEqual(await assistantTexts(), ["answer two"]);
      await providerIs("gemini");
      await open();
      assert.equal((await sidebarChats()).length, 2, "imported history persists");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects a file that is not a chat export and changes nothing", async () => {
    await configured();
    await send("q");
    await finished();
    const dir = mkdtempSync(join(tmpdir(), "gtps-bad-"));
    try {
      const path = join(dir, "bad.json");
      const fs = await import("node:fs");
      fs.writeFileSync(path, '{"hello":"world"}');
      await page.getByRole("button", { name: "Go to chat settings" }).click();
      await page.getByLabel("Import chat history file").setInputFiles(path);
      await page.getByText(/Import failed: This is not a GTPS Assistant chat export/).waitFor();
      await page.getByTestId("history-counts").getByText(/1 chat\(s\)/).waitFor();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("error recovery in the UI", () => {
  it("shows a rejected key as an error with a link to settings, and Try again works after fixing it", async () => {
    await configured();
    be.groq.queue({ status: 401, body: JSON.stringify({ error: { message: "Invalid API Key", code: "invalid_api_key" } }) });
    await send("hello");
    const alert = page.getByRole("alert").filter({ hasText: "Invalid API Key" });
    await alert.waitFor();
    assert.equal(await alert.getByRole("link", { name: "Open AI Providers settings" }).count(), 1);
    assert.deepEqual(await userTexts(), ["hello"], "the question is kept");
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByText("Hello wörld ✓").waitFor();
    assert.equal(await page.getByRole("alert").filter({ hasText: "Invalid API Key" }).count(), 0);
  });
  it("shows a rate limit with how long to wait", async () => {
    await configured();
    be.groq.queue({ status: 429, headers: { "retry-after": "90" }, body: JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded" } }) });
    await send("hello");
    await page.getByRole("alert").filter({ hasText: "Rate limit reached" }).getByText(/1 min 30 s/).waitFor();
  });
  it("a dropped connection keeps the partial text and offers Try again", async () => {
    await configured();
    be.groq.queue({ stream: [partial("partial text")], destroyAfterStream: true });
    await send("hello");
    await page.getByRole("button", { name: "Try again" }).waitFor();
    assert.deepEqual(await assistantTexts(), ["partial text"]);
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByText("Hello wörld ✓").waitFor();
  });
  it("recovers after the local backend becomes reachable again", async () => {
    await configured();
    await page.route("**/api/ai/**", (route) => route.abort());
    await page.getByRole("button", { name: "Refresh model list" }).click();
    await page.getByText("Can't reach the local backend.").waitFor();
    await page.unroute("**/api/ai/**");
    await page.getByRole("button", { name: "Retry" }).click();
    await page.locator("#model-select").waitFor();
    await send("works again");
    await page.getByText("Hello wörld ✓").waitFor();
  });
});

describe("auto-scroll", () => {
  const lines = Array.from({ length: 70 }, (_, i) => `Paragraph ${i + 1}: some text that fills the line.\n\n`);

  it("follows a long streaming reply to the bottom", async () => {
    await configured();
    be.groq.queue({ stream: groqEvents(lines), chunkDelayMs: 8 });
    await send("long");
    await finished();
    assert.equal(await atBottom(), true);
    assert.ok(await page.getByTestId("message-scroller").evaluate((el) => el.scrollHeight > el.clientHeight + 200), "the content really is taller than the view");
  });
  it("stops following when the reader scrolls up, offers a way back, and a new message goes to the bottom", async () => {
    await configured();
    be.groq.queue({ stream: groqEvents(lines), chunkDelayMs: 8 });
    await send("long");
    await page.getByText("Paragraph 20:").waitFor();
    await page.getByTestId("message-scroller").evaluate((el) => (el.scrollTop = 0));
    await page.getByRole("button", { name: "Scroll to latest message" }).waitFor();
    await finished();
    const top = await page.getByTestId("message-scroller").evaluate((el) => el.scrollTop);
    assert.ok(top < 100, `reader's position is kept (scrollTop ${top})`);

    await page.getByRole("button", { name: "Scroll to latest message" }).click();
    assert.equal(await atBottom(), true);
    await page.getByRole("button", { name: "Scroll to latest message" }).waitFor({ state: "detached" });

    await page.getByTestId("message-scroller").evaluate((el) => (el.scrollTop = 0));
    be.groq.setReply(["short"]);
    await send("another");
    await finished();
    assert.equal(await atBottom(), true, "sending always returns to the bottom");
  });
  it("opening another chat shows it from the bottom", async () => {
    await configured();
    be.groq.queue({ stream: groqEvents(lines) });
    await send("long chat");
    await finished();
    await page.getByRole("button", { name: "New Chat" }).click();
    await send("short chat");
    await finished();
    await page.getByRole("button", { name: /long chat/ }).first().click();
    assert.equal(await atBottom(), true);
  });
});

describe("generating in the background", () => {
  it("a reply keeps streaming while another chat is open, and the history marks it", async () => {
    await configured();
    be.groq.queue({ stream: groqEvents(["slow ", "reply ", "text"]), chunkDelayMs: 150 });
    await send("background chat");
    await page.getByText("slow").waitFor();
    await page.getByRole("button", { name: "New Chat" }).click();
    await welcomeShown();
    assert.equal(await page.getByRole("status", { name: "Generating a reply" }).count(), 1, "the history shows which chat is busy");
    assert.equal(await page.getByRole("button", { name: "Send message" }).count(), 1, "the new chat can send");
    await page.getByRole("button", { name: /background chat/ }).first().click();
    await page.getByText("slow reply text").waitFor();
    await finished();
  });
});
