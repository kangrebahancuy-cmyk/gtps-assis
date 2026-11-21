/**
 * Every settings page in real Chromium: real React panels, real controllers, real IndexedDB/localStorage, the real AI
 * backend (fake Gemini/Groq servers) and the real sync/documentation-source backend (SyncService, SQLite, scheduler
 * settings, approved-domain enforcement) in front of a local fake documentation SITE over HTTP.
 *
 * Stand-ins, stated plainly:
 *  - @radix-ui/react-switch is not installed: a small stub with the same role/aria-checked/onCheckedChange contract
 *    (tests/browser/support/radix-switch-stub.tsx). Zustand is stubbed too (it only holds the mobile-drawer flag now).
 *  - Monaco is the textarea stand-in; the workspace here uses the real basic editor.
 *  - Tailwind is not available: tests/browser/support/*.css supply a few layout rules, so nothing says how it looks.
 *  - The documentation pages are SYNTHETIC fixtures served from 127.0.0.1; the real dash.gtps.cloud is never contacted.
 * Run with `npm run test:browser`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";

import { GEMINI_KEY, GROQ_KEY } from "../ai-fakes";
import { startBackend, type Backend } from "../support/backend";
import { createSyncRig, startSite, type Site, type SyncRig } from "../support/sync-rig";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

let be: Backend;
let rig: SyncRig;
let docSite: Site;
let site: TestSite;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const errors: string[] = [];

before(async () => {
  rig = createSyncRig();
  // The backend asks the CURRENT rig on every request, so each test can start from a fresh sync database.
  be = await startBackend({ sync: { route: (request: Request) => rig.route(request) } as SyncRig });
  const css = ["layout.css", "workspace.css"].map((f) => readFileSync(join(ROOT, "tests/browser/support", f), "utf8")).join("\n");
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/settings-app.tsx")), [(req, res) => be.http(req, res)], '<div id="root"></div>', css);
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.close();
  await be.close();
  rig.close();
});
beforeEach(async () => {
  await be.reset();
  rig.close();
  rig = createSyncRig();
  docSite = await startSite();
  errors.length = 0;
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(6000);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
});
afterEach(async () => {
  await context.close();
  await docSite.close();
  assert.deepEqual(errors, [], "no script errors in the page");
  assert.equal(be.gemini.pending() + be.groq.pending(), 0, "leaked override");
});

const open = async (pageId = "providers", p: Page = page) => {
  await p.goto(`${site.origin}/?page=${pageId}`);
  await p.locator(`[data-page-content="${pageId}"]`).waitFor();
};
const go = async (pageId: string, p: Page = page) => {
  await p.locator(`nav[aria-label="Pages"] [data-page="${pageId}"]`).click();
  await p.locator(`[data-page-content="${pageId}"]`).waitFor();
};
const html = () => page.evaluate(() => ({ cls: document.documentElement.className, font: getComputedStyle(document.documentElement).fontSize }));
const saved = <T>(key: string, p: Page = page) => p.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null") as T, key);
const prefs = () => saved<{ prefs: Record<string, unknown> }>("gtps-assistant:prefs").then((v) => v?.prefs ?? null);
const readDownload = async (action: () => Promise<unknown>, p: Page = page) => {
  const [download] = await Promise.all([p.waitForEvent("download"), action()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: readFileSync(path, "utf8") };
};
const allowSite = async () => {
  await open("documentation");
  await page.getByLabel("Allow another domain").fill(docSite.host);
  await page.getByRole("button", { name: "Add domain…" }).click();
  await page.getByRole("button", { name: "Yes, allow it" }).click();
  await page.getByText(`${docSite.host} is now allowed.`).waitFor();
  await page.getByLabel("Documentation source URL").fill(`${docSite.origin}/docs`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Documentation settings saved.").waitFor();
};
const syncState = () => page.getByTestId("sync-state").innerText();
const idle = () => page.waitForFunction(() => document.querySelector('[data-testid="sync-state"]')?.textContent === "idle");

describe("AI provider settings", () => {
  it("saves both keys, never shows or stores them in the browser, and reports the status", async () => {
    await open("providers");
    assert.equal(await page.locator("span", { hasText: /^Not configured$/ }).count(), 2);
    await page.locator("#gemini-api-key").fill(GEMINI_KEY);
    await page.locator("#groq-api-key").fill(GROQ_KEY);
    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.locator("span", { hasText: /^Key saved/ }).first().waitFor();
    assert.equal(await page.locator("span", { hasText: /^Key saved/ }).count(), 2);
    assert.equal(await page.locator("#gemini-api-key").inputValue(), "", "the field is emptied after saving");
    const everywhere = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return JSON.stringify({ ls: { ...localStorage }, dbs: dbs.map((d) => d.name), body: document.body.innerHTML });
    });
    assert.ok(!everywhere.includes(GEMINI_KEY) && !everywhere.includes(GROQ_KEY), "no key in the page, localStorage or database names");
    assert.ok(!everywhere.includes(GEMINI_KEY.slice(6, 20)), "not even part of it");
  });

  it("tests a connection: success, a wrong key, and a reply from the model", async () => {
    await be.configure();
    await open("providers");
    const gemini = page.getByRole("region").filter({ hasText: "Gemini" }).first();
    await page.getByRole("button", { name: "Test connection" }).first().click();
    await page.getByText(/Connected\. \d+ models found/).first().waitFor();
    await page.locator("#groq-api-key").fill("wrong-key");
    await page.getByRole("button", { name: "Test this key" }).click();
    await page.getByRole("alert").filter({ hasText: /./ }).first().waitFor();
    assert.match(await page.getByRole("alert").first().innerText(), /key|auth|invalid|rejected/i);
    await page.locator("#groq-api-key").fill("");
    await page.getByRole("button", { name: "Test a reply" }).nth(1).click();
    await page.getByText(/produced a reply/).waitFor();
    void gemini;
  });

  it("refreshes the model list and saves the default provider and model, which survive a reload", async () => {
    await be.configure();
    await open("models");
    await page.getByRole("button", { name: "Refresh models" }).click();
    await page.getByText("llama-demo-70b").first().waitFor();
    await page.locator("#default-provider").selectOption("groq");
    await page.locator("#default-model").selectOption("llama-demo-70b");
    await page.getByRole("button", { name: "Save configuration" }).click();
    await page.getByText("Saved: Groq · llama-demo-70b").waitFor();
    await open("models");
    await page.getByText("Saved: Groq · llama-demo-70b").waitFor();
  });
});

describe("documentation settings", () => {
  it("shows the defaults and the approved domains", async () => {
    await open("documentation");
    assert.equal(await page.getByLabel("Documentation source URL").inputValue(), "https://dash.gtps.cloud/docs");
    assert.equal(await page.getByLabel("Main website URL").inputValue(), "https://gtps.cloud/");
    assert.match(await page.getByTestId("approved-domains").innerText(), /gtps\.cloud/);
    await page.getByTestId("no-extra-domains").waitFor();
    assert.equal(await page.getByRole("link", { name: /Open main website/ }).getAttribute("href"), "https://gtps.cloud/");
  });

  it("refuses a source on an unapproved domain, says why, and keeps the old one", async () => {
    await open("documentation");
    await page.getByLabel("Documentation source URL").fill("https://example.com/docs");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /example\.com is not an approved/ }).waitFor();
    await open("documentation");
    assert.equal(await page.getByLabel("Documentation source URL").inputValue(), "https://dash.gtps.cloud/docs");
    assert.equal(rig.service.getConfig().origin, "https://dash.gtps.cloud");
    assert.equal(rig.docsSource.get().sourceUrl, "https://dash.gtps.cloud/docs");
  });

  it("refuses a lookalike domain and a plain-http address", async () => {
    await open("documentation");
    for (const [value, re] of [["https://evilgtps.cloud/docs", /evilgtps\.cloud is not an approved/], ["http://dash.gtps.cloud/docs", /Only https/]] as const) {
      await page.getByLabel("Documentation source URL").fill(value);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: re }).waitFor();
    }
  });

  it("accepts an approved subdomain without any extra step", async () => {
    await open("documentation");
    await page.getByLabel("Documentation source URL").fill("https://docs.gtps.cloud/v2");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Documentation settings saved.").waitFor();
    assert.equal(rig.docsSource.get().sourceUrl, "https://docs.gtps.cloud/v2");
    assert.equal(rig.service.getConfig().origin, "https://docs.gtps.cloud");
    assert.equal(rig.service.getConfig().pathPrefix, "/v2");
  });

  it("another domain needs the user's explicit confirmation; cancelling adds nothing", async () => {
    await open("documentation");
    await page.getByLabel("Allow another domain").fill("docs.example.com");
    await page.getByRole("button", { name: "Add domain…" }).click();
    await page.getByRole("alertdialog", { name: "Confirm new domain" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.deepEqual(rig.docsSource.get().extraDomains, []);
    await page.getByRole("button", { name: "Add domain…" }).click();
    await page.getByRole("button", { name: "Yes, allow it" }).click();
    await page.getByText("docs.example.com is now allowed.").waitFor();
    assert.deepEqual(rig.docsSource.get().extraDomains, ["docs.example.com"]);
    await page.getByLabel("Documentation source URL").fill("https://docs.example.com/guide");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Documentation settings saved.").waitFor();
    // The domain is now in use, so removing it is refused with a reason.
    await page.getByRole("button", { name: "Remove docs.example.com" }).click();
    await page.getByRole("alert").filter({ hasText: /used by the documentation source/ }).waitFor();
    assert.deepEqual(rig.docsSource.get().extraDomains, ["docs.example.com"]);
    // "Restore defaults" brings back the approved source, after which the extra domain can go.
    await page.getByRole("button", { name: "Restore defaults" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByText("Documentation settings saved.").waitFor();
    await page.getByRole("button", { name: "Remove docs.example.com" }).click();
    await page.getByText("docs.example.com removed.").waitFor();
    await page.getByTestId("no-extra-domains").waitFor();
  });

  it("rejects junk domains (wildcards, a bare TLD, an address with a path)", async () => {
    await open("documentation");
    for (const bad of ["*.example.com", "com", "bad domain"]) {
      await page.getByLabel("Allow another domain").fill(bad);
      await page.getByRole("button", { name: "Add domain…" }).click();
      await page.getByRole("button", { name: "Yes, allow it" }).click();
      await page.getByRole("alert").filter({ hasText: /host name such as/ }).waitFor();
    }
    assert.deepEqual(rig.docsSource.get().extraDomains, []);
  });

  it("changing the source while documents are indexed needs a confirmation, and keeps the indexed pages", async () => {
    await allowSite();
    await go("synchronization");
    await page.getByRole("button", { name: "Full sync" }).click();
    await page.getByText("3", { exact: true }).first().waitFor();
    await idle();
    assert.equal(rig.repo.getStats().documents, 3);
    const other = await startSite({ "/docs": { text: "A different site overview." } });
    try {
      await go("documentation");
      await page.getByLabel("Documentation source URL").fill(`${other.origin}/docs`);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("alertdialog", { name: "Confirm source change" }).waitFor();
      assert.match(await page.getByRole("alertdialog").innerText(), /3 document\(s\)/);
      assert.equal(rig.service.getConfig().origin, docSite.origin, "nothing changed yet");
      await page.getByRole("button", { name: "Cancel" }).click();
      assert.equal(rig.service.getConfig().origin, docSite.origin);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("button", { name: "Yes, change the source" }).click();
      await page.getByText("Documentation settings saved.").waitFor();
      assert.equal(rig.service.getConfig().origin, other.origin);
      assert.equal(rig.repo.getStats().documents, 3, "indexed pages are kept");
    } finally {
      await other.close();
    }
  });

  it("the source and the allowed domains survive a reload (stored by the backend)", async () => {
    await allowSite();
    await open("documentation");
    assert.equal(await page.getByLabel("Documentation source URL").inputValue(), `${docSite.origin}/docs`);
    assert.deepEqual(await page.getByTestId("extra-domains").locator("li span.font-mono").allInnerTexts(), [docSite.host]);
  });
});

describe("synchronization settings", () => {
  it("runs a full sync from the page and shows real counts and log lines", async () => {
    await allowSite();
    await go("synchronization");
    await idle();
    await page.getByRole("button", { name: "Full sync" }).click();
    await page.getByText("Total documents").waitFor();
    await page.waitForFunction(() => /\b3\b/.test(document.body.innerText) && document.querySelector('[data-testid="sync-state"]')?.textContent === "idle");
    assert.equal(rig.repo.getStats().documents, 3);
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByTestId("log-row").first().waitFor();
    const rows = await page.getByTestId("log-row").allInnerTexts();
    assert.ok(rows.some((r) => /New page added/.test(r)), rows.join("\n"));
    assert.ok(docSite.hits.includes("/docs/alpha"));
  });

  it("incremental sync leaves unchanged pages alone; a changed page is updated", async () => {
    await allowSite();
    await go("synchronization");
    await page.getByRole("button", { name: "Full sync" }).click();
    await idle();
    await page.waitForFunction(() => /Total documents/.test(document.body.innerText));
    docSite.pages["/docs/alpha"] = { text: "Alpha page rewritten with new text." };
    await page.getByRole("button", { name: "Incremental" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="sync-state"]')?.textContent === "idle");
    await page.waitForTimeout(300);
    const run = rig.service.getStatus().lastRun!;
    assert.equal(run.mode, "incremental");
    assert.equal(run.counts.updated, 1);
    assert.equal(run.counts.unchanged, 2);
  });

  it("lists failed documents and retries only those", async () => {
    await allowSite();
    docSite.pages["/docs/beta"] = { text: "Beta", status: 503 };
    await go("synchronization");
    await page.getByRole("button", { name: "Full sync" }).click();
    await page.getByTestId("failed-pages").waitFor();
    assert.match(await page.getByTestId("failed-pages").innerText(), /\/docs\/beta/);
    docSite.pages["/docs/beta"] = { text: "Beta page is back with real text." };
    docSite.hits.length = 0;
    await page.getByRole("button", { name: /Retry failed/ }).click();
    await page.getByTestId("failed-pages").waitFor({ state: "detached" });
    assert.deepEqual(docSite.hits.filter((h) => h.startsWith("/docs")), ["/docs/beta"], "only the failed page was requested");
    assert.equal(rig.service.getStatus().totals.failedOutstanding, 0);
  });

  it("can cancel a running sync", async () => {
    await allowSite();
    docSite.pages["/docs"] = { text: "Slow overview page text.", links: ["/docs/alpha"], delayMs: 1500 };
    await go("synchronization");
    await page.getByRole("button", { name: "Full sync" }).click();
    await page.getByRole("button", { name: "Cancel" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Full sync" }).waitFor();
    assert.equal(rig.service.getStatus().lastRun?.status, "cancelled");
  });

  it("automatic sync and the interval are saved by the backend and still there after a reload", async () => {
    await open("synchronization");
    await page.getByRole("switch", { name: "Automatic sync" }).click();
    await page.waitForFunction(() => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true");
    await page.getByLabel("Sync interval").selectOption("360");
    await page.getByLabel("Custom interval (minutes)").fill("45");
    await page.getByRole("button", { name: "Set interval" }).click();
    await page.waitForFunction(() => (document.querySelector("#sync-interval") as HTMLSelectElement | null)?.value === "45");
    assert.deepEqual(rig.scheduler.getSettings(), { autoEnabled: true, intervalMinutes: 45, schedulePaused: false });
    await open("synchronization");
    assert.equal(await page.getByRole("switch", { name: "Automatic sync" }).getAttribute("aria-checked"), "true");
    assert.equal(await page.getByLabel("Sync interval").inputValue(), "45");
  });

  it("refuses an out-of-range custom interval", async () => {
    await open("synchronization");
    for (const bad of ["1", "abc", "999999"]) {
      await page.getByLabel("Custom interval (minutes)").fill(bad);
      await page.getByRole("button", { name: "Set interval" }).click();
      await page.getByRole("alert").filter({ hasText: /whole number of minutes/ }).waitFor();
    }
    assert.equal(rig.scheduler.getSettings().intervalMinutes, 60);
  });

  it("log filters: by level, and an empty state before any run", async () => {
    await open("synchronization");
    await page.getByTestId("log-empty").waitFor();
    await allowSite();
    docSite.pages["/docs/beta"] = { text: "Beta", status: 503 };
    await go("synchronization");
    await page.getByRole("button", { name: "Full sync" }).click();
    await page.getByTestId("failed-pages").waitFor();
    await page.getByRole("button", { name: "Refresh" }).click();
    await page.getByLabel("Level").selectOption("error");
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="log-row"]')].every((r) => r.getAttribute("data-level") === "error"));
    assert.ok((await page.getByTestId("log-row").count()) >= 1);
  });

  it("says so when the sync backend cannot be reached", async () => {
    await open("synchronization");
    await page.route("**/api/sync/status", (route) => route.abort());
    await page.getByText(/Cannot reach the local backend/).waitFor({ timeout: 15000 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Chat, appearance, backup/restore and local data
// ---------------------------------------------------------------------------------------------------------------
const MD_REPLY = 'Here is **bold** text:\n\n```lua\n-- say hi\nlocal x = 1\nprint("hi", x)\n```\n';
const composer = (p: Page = page) => p.getByLabel("Message", { exact: true });
const finished = (p: Page = page) =>
  p.waitForFunction(() => {
    const users = document.querySelectorAll('article[data-role="user"]').length;
    const replies = [...document.querySelectorAll('article[data-role="assistant"]')];
    return users > 0 && replies.length === users && replies[replies.length - 1]?.getAttribute("data-status") !== "streaming" && !document.querySelector('[aria-label="Stop generating"]');
  });
const sendChat = async (text: string, p: Page = page) => {
  await composer(p).fill(text);
  await composer(p).press("Enter");
  await finished(p);
};
const storedChats = (p: Page = page) => p.getByTestId("stored-chat").allInnerTexts();
const counts = (p: Page = page) => p.getByTestId("history-counts").innerText();
const newFile = async (name: string, p: Page = page) => {
  await p.getByRole("button", { name: "New file" }).first().click();
  const field = p.getByLabel("New file name");
  await field.fill(name);
  await field.press("Enter");
};
const editor = (p: Page = page) => p.getByTestId("basic-editor");
const fileNamesOf = async (p: Page = page) => (await p.locator('[data-testid="file-row"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-name")))).sort();
const switchOn = async (name: string, p: Page = page) => (await p.getByRole("switch", { name }).getAttribute("aria-checked")) === "true";
const readPlainText = (text: string) => JSON.parse(text) as Record<string, any>;

describe("chat settings", () => {
  it("the default provider and model are saved here and used by the next new chat", async () => {
    await be.configure();
    await open("chat");
    await page.locator("#chat-default-provider").selectOption("gemini");
    await page.locator("#chat-default-model").selectOption("gemini-alpha");
    await page.getByRole("button", { name: "Save default" }).click();
    await page.getByText(/saved/i).first().waitFor();
    assert.deepEqual((await be.service.getSettings()).defaults, { provider: "gemini", model: "gemini-alpha" });
    await page.getByRole("button", { name: "New Chat" }).first().click();
    await page.locator("#provider-select").waitFor();
    assert.equal(await page.locator("#provider-select").inputValue(), "gemini");
    assert.equal(await page.locator("#model-select").inputValue(), "gemini-alpha");
    // Change it again: the other provider is used next time, and Settings → Models shows the same single default.
    await go("chat");
    await page.locator("#chat-default-provider").selectOption("groq");
    await page.locator("#chat-default-model").selectOption("llama-demo-70b");
    await page.getByRole("button", { name: "Save default" }).click();
    await go("models");
    await page.getByText("Saved: Groq · llama-demo-70b").waitFor();
  });

  it("with no provider configured it says so instead of offering nothing", async () => {
    await open("chat");
    await page.getByTestId("chat-no-provider").waitFor();
  });

  it("Markdown preferences change how replies look, at once and after a reload", async () => {
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    be.groq.setReply([MD_REPLY]);
    await open("chat");
    await go("chat");
    await page.getByRole("button", { name: "Open chat" }).click();
    await sendChat("show markdown");
    const bold = () => page.locator('[data-testid="assistant-text"] strong').count();
    const spans = () => page.locator('[data-testid="assistant-text"] pre span').count();
    const wrap = () => page.locator('[data-testid="assistant-text"] pre').evaluate((el) => [el.getAttribute("data-wrap"), getComputedStyle(el).whiteSpace]);
    assert.equal(await bold(), 1);
    assert.ok((await spans()) > 0, "Lua is highlighted by default");
    assert.deepEqual(await wrap(), ["off", "pre"]);

    await go("chat");
    await page.getByRole("switch", { name: "Wrap long code lines" }).click();
    await page.getByRole("switch", { name: "Highlight Lua code" }).click();
    await page.getByRole("button", { name: "Open chat" }).click();
    assert.deepEqual(await wrap(), ["on", "pre-wrap"]);
    assert.equal(await spans(), 0, "no colouring when highlighting is off");

    await go("chat");
    await page.getByRole("switch", { name: "Render Markdown" }).click();
    await page.getByRole("button", { name: "Open chat" }).click();
    assert.equal(await bold(), 0);
    assert.match(await page.getByTestId("plain-text").innerText(), /\*\*bold\*\*/);
    assert.deepEqual(await prefs().then((p) => [p?.renderMarkdown, p?.highlightCode, p?.wrapCode]), [false, false, true]);

    await open("chat"); // reload
    assert.equal(await switchOn("Render Markdown"), false);
    assert.equal(await switchOn("Wrap long code lines"), true);
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.getByTestId("plain-text").waitFor();
  });

  it("chat history management: list, delete one with confirmation, export, import (duplicates skipped), clear", async () => {
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    await open("chat");
    await page.getByRole("button", { name: "Open chat" }).click();
    await sendChat("first question");
    await page.getByRole("button", { name: "New Chat" }).first().click();
    await sendChat("second question");
    await go("chat");
    assert.equal((await storedChats()).length, 2);
    assert.match(await counts(), /2/);
    // delete one: needs a second click
    await page.getByTestId("stored-chats").getByRole("button", { name: "Delete chat first question" }).click();
    assert.equal((await storedChats()).length, 2, "nothing deleted by the first click");
    await page.getByRole("button", { name: "Cancel" }).first().click();
    assert.equal((await storedChats()).length, 2);
    await page.getByTestId("stored-chats").getByRole("button", { name: "Delete chat first question" }).click();
    await page.getByRole("button", { name: "Delete this chat" }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="stored-chat"]').length === 1);
    assert.match((await storedChats())[0]!, /second question/);

    const exported = await readDownload(() => page.getByRole("button", { name: "Export JSON" }).click());
    const file = readPlainText(exported.text);
    assert.equal(file.format, "gtps-assistant-chat-export");
    assert.equal(file.conversations.length, 1);
    assert.doesNotMatch(exported.text, new RegExp(`${GROQ_KEY}|${GEMINI_KEY}`));

    await page.getByRole("button", { name: "Clear all history" }).click();
    await page.getByRole("button", { name: "Yes, delete everything" }).click();
    await page.getByTestId("no-chats").waitFor();

    const input = page.locator('input[aria-label="Import chat history file"]');
    await input.setInputFiles({ name: "chats.json", mimeType: "application/json", buffer: Buffer.from(exported.text) });
    await page.getByText(/Imported 1 chat\(s\) with 2 message\(s\)/).waitFor();
    await input.setInputFiles({ name: "chats.json", mimeType: "application/json", buffer: Buffer.from(exported.text) });
    await page.getByText(/1 already existed and were skipped/).waitFor();
    assert.equal((await storedChats()).length, 1);
    await input.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{nope") });
    await page.getByText(/Import failed/).waitFor();
    assert.equal((await storedChats()).length, 1, "a bad file changes nothing");
  });
});

describe("appearance", () => {
  it("dark/light mode and text size apply at once, are saved, and survive a reload", async () => {
    await open("appearance");
    assert.match((await html()).cls, /dark/);
    assert.equal(await switchOn("Dark mode"), true);
    await page.getByRole("switch", { name: "Dark mode" }).click();
    assert.doesNotMatch((await html()).cls, /dark/);
    assert.equal((await prefs())?.theme, "light");
    await page.getByLabel("Text size").selectOption("large");
    assert.equal((await html()).font, "18px");
    await page.getByLabel("Text size").selectOption("small");
    assert.equal((await html()).font, "14px");
    await open("appearance");
    assert.doesNotMatch((await html()).cls, /dark/);
    assert.equal((await html()).font, "14px");
    assert.equal(await switchOn("Dark mode"), false);
    await page.getByRole("switch", { name: "Dark mode" }).click();
    assert.match((await html()).cls, /dark/);
  });

  it("the sidebar preferences collapse it and hide the chat list, and are saved", async () => {
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    await open("chat");
    await page.getByRole("button", { name: "Open chat" }).click();
    await sendChat("a chat for the sidebar");
    await page.getByRole("list", { name: "Chats" }).waitFor();
    await go("appearance");
    await page.getByRole("switch", { name: "Show recent chats" }).click();
    await page.getByRole("list", { name: "Chats" }).waitFor({ state: "detached" });
    await page.getByTestId("sidebar-spacer").waitFor();
    await page.getByRole("switch", { name: "Show recent chats" }).click();
    await page.getByRole("list", { name: "Chats" }).waitFor();
    assert.equal(await page.getByTestId("sidebar").getAttribute("data-collapsed"), "false");
    await page.getByRole("switch", { name: "Collapse the sidebar" }).click();
    assert.equal(await page.getByTestId("sidebar").getAttribute("data-collapsed"), "true");
    await open("appearance");
    assert.equal(await page.getByTestId("sidebar").getAttribute("data-collapsed"), "true");
    assert.equal(await switchOn("Collapse the sidebar"), true);
    assert.equal((await prefs())?.sidebarCollapsed, true);
  });

  it("the editor theme and font size reach the Lua editor, are clamped, and are saved", async () => {
    await open("view:workspace");
    const ed = editor();
    await ed.waitFor();
    const look = () => ed.evaluate((el) => [el.closest("[data-editor-theme]")?.getAttribute("data-editor-theme"), el.getAttribute("data-font-size"), getComputedStyle(el).fontSize]);
    assert.deepEqual(await look(), ["dark", "13", "13px"], "defaults");
    await go("appearance");
    await page.getByLabel("Editor theme").selectOption("light");
    await page.getByRole("button", { name: "Increase editor font size" }).click();
    await page.getByRole("button", { name: "Increase editor font size" }).click();
    await page.getByRole("button", { name: "Open workspace" }).click();
    assert.deepEqual(await look(), ["light", "15", "15px"]);
    await go("appearance");
    await page.getByLabel("Editor theme").selectOption("high-contrast");
    await page.getByRole("spinbutton", { name: "Editor font size" }).fill("99");
    assert.equal(await page.getByRole("spinbutton", { name: "Editor font size" }).inputValue(), "24", "clamped to the maximum");
    await page.getByRole("spinbutton", { name: "Editor font size" }).fill("2");
    assert.equal(await page.getByRole("spinbutton", { name: "Editor font size" }).inputValue(), "10", "clamped to the minimum");
    await page.getByRole("spinbutton", { name: "Editor font size" }).fill("20");
    assert.equal(await page.getByTestId("editor-preview").evaluate((el) => getComputedStyle(el).fontSize), "20px");
    await page.getByRole("button", { name: "Open workspace" }).click();
    assert.deepEqual(await look(), ["high-contrast", "20", "20px"]);
    await open("view:workspace"); // reload
    assert.deepEqual(await editor().evaluate((el) => [el.closest("[data-editor-theme]")?.getAttribute("data-editor-theme"), getComputedStyle(el).fontSize]), ["high-contrast", "20px"]);
    // "Match the app" follows dark/light again.
    await go("appearance");
    await page.getByLabel("Editor theme").selectOption("auto");
    await page.getByRole("switch", { name: "Dark mode" }).click();
    await page.getByRole("button", { name: "Open workspace" }).click();
    assert.equal(await editor().evaluate((el) => el.closest("[data-editor-theme]")?.getAttribute("data-editor-theme")), "light");
  });

  it("reset puts every preference back to its default", async () => {
    await open("appearance");
    await page.getByRole("switch", { name: "Dark mode" }).click();
    await page.getByLabel("Text size").selectOption("large");
    await page.getByRole("button", { name: "Reset all preferences to defaults" }).click();
    assert.match((await html()).cls, /dark/);
    assert.equal((await html()).font, "16px");
    assert.equal(await page.getByRole("button", { name: "Reset all preferences to defaults" }).isDisabled(), true);
  });

  it("damaged saved preferences fall back to the defaults; the earlier theme setting is carried over", async () => {
    await page.addInitScript(() => localStorage.setItem("gtps-assistant:prefs", "{not json"));
    await open("appearance");
    assert.match((await html()).cls, /dark/);
    await context.close();
    context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => localStorage.setItem("gtps-assistant:ui", JSON.stringify({ state: { theme: "light", sidebarCollapsed: true }, version: 0 })));
    await open("appearance");
    assert.doesNotMatch((await html()).cls, /dark/);
    assert.equal(await page.getByTestId("sidebar").getAttribute("data-collapsed"), "true");
  });
});

describe("backup and restore", () => {
  /** A browser with one chat, two Lua files (one with an unsaved edit) and changed preferences. */
  const seed = async (p: Page = page) => {
    await be.configure({ provider: "groq", model: "llama-demo-70b" });
    await open("chat", p);
    await p.getByRole("button", { name: "Open chat" }).click();
    await sendChat("backup me", p);
    await p.getByRole("button", { name: "Open workspace" }).click();
    await newFile("shop", p);
    await editor(p).fill("print('v1 saved')");
    await editor(p).press("Control+S");
    await p.getByTestId("saved-badge").waitFor();
    await editor(p).fill("print('v2 unsaved draft')");
    await p.waitForTimeout(700); // drafts are written 400 ms after typing stops
    await go("appearance", p);
    await p.getByRole("switch", { name: "Dark mode" }).click();
    await p.getByRole("spinbutton", { name: "Editor font size" }).fill("17");
    await go("backup", p);
  };
  const download = () => readDownload(() => page.getByRole("button", { name: "Download backup" }).click());
  const pick = (buffer: Buffer | string, p: Page = page, name = "backup.json") => p.locator("#backup-file").setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(buffer) });
  /** The plan is recomputed asynchronously after every option change, so wait for the line to show what is expected. */
  const planShows = async (id: string, re: RegExp, p: Page = page) => {
    await p.getByTestId(id).filter({ hasText: re }).waitFor();
  };
  const confirmText = () => page.getByTestId("restore-confirm").innerText();

  it("exports everything the user created, checksummed, with counts and no keys", async () => {
    await seed();
    const { name, text } = await download();
    assert.match(name, /^gtps-assistant-backup-\d{4}-\d{2}-\d{2}\.json$/);
    const { parseBackup } = await import("@/lib/backup/format");
    const parsed = await parseBackup(text); // the real validator accepts it: checksum and structure
    assert.deepEqual(parsed.summary, { conversations: 1, messages: 2, files: 2 });
    const shop = parsed.data.workspace.files.find((f) => f.name === "shop.lua")!;
    assert.equal(shop.content, "print('v1 saved')");
    assert.equal(shop.draft, "print('v2 unsaved draft')");
    assert.equal(parsed.data.preferences.theme, "light");
    assert.equal(parsed.data.preferences.editorFontSize, 17);
    assert.deepEqual(Object.keys(readPlainText(text).data).sort(), ["chats", "preferences", "workspace"]);
    assert.doesNotMatch(text, new RegExp(`${GROQ_KEY}|${GEMINI_KEY}|apiKey|extraDomains|sourceUrl`));
    await page.getByText(/Backup downloaded: 1 chat \(2 messages\), 2 Lua files/).waitFor();
  });

  it("rejects damaged, edited, truncated and foreign files with a clear reason, and changes nothing", async () => {
    await seed();
    const { text } = await download();
    const before = await fileNamesOf(await (async () => { await page.getByRole("button", { name: "Open workspace" }).click(); return page; })());
    await go("backup");
    const rejects = async (content: string, re: RegExp) => {
      await pick(content);
      await page.getByTestId("backup-error").filter({ hasText: re }).waitFor();
      assert.equal(await page.getByTestId("backup-valid").count(), 0);
      assert.match(await page.getByTestId("backup-error").innerText(), /Nothing was imported/);
    };
    await rejects("this is not json", /not valid JSON/);
    await rejects(text.slice(0, Math.floor(text.length / 2)), /not valid JSON/);
    await rejects(text.replace("backup me", "backup ME"), /checksum does not match/);
    await rejects(JSON.stringify({ hello: "world" }), /not a GTPS Assistant backup/);
    await rejects(JSON.stringify({ ...readPlainText(text), version: 42 }), /newer version/);
    const chatExport = readPlainText(await (async () => { await go("chat"); return (await readDownload(() => page.getByRole("button", { name: "Export JSON" }).click())).text; })());
    await go("backup");
    await rejects(JSON.stringify(chatExport), /chat export, not a full backup/);
    await pick(text); // then a good file still works
    await page.getByTestId("backup-valid").waitFor();
    assert.equal(await page.getByTestId("backup-error").count(), 0);
    await page.getByRole("button", { name: "Open workspace" }).click();
    assert.deepEqual(await fileNamesOf(), before);
    await go("chat");
    assert.match(await counts(), /1/);
  });

  it("restoring into an empty browser: shows a plan, needs confirmation, and brings everything back", async () => {
    await seed();
    const { text } = await download();
    const fresh = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const p2 = await fresh.newPage();
    p2.on("pageerror", (e) => errors.push(`pageerror(p2): ${e.message}`));
    try {
      await open("backup", p2);
      await pick(text, p2);
      await p2.getByTestId("backup-valid").waitFor();
      assert.match(await p2.getByTestId("backup-valid").innerText(), /1 chat \(2 messages\), 2 Lua files/);
      assert.match(await p2.getByTestId("plan-chats").innerText(), /1 to add/);
      assert.match(await p2.getByTestId("plan-files").innerText(), /to add/);
      // the starter main.lua of the fresh workspace is identical to the backup's, so only shop.lua is new
      assert.match(await p2.getByTestId("plan-files").innerText(), /1 to add, 1 already identical/);
      await p2.getByRole("button", { name: "Import…" }).click();
      assert.match(await p2.getByTestId("restore-confirm").innerText(), /Nothing you have now will be deleted or changed/);
      await p2.getByRole("button", { name: "Cancel" }).click();
      await go("chat", p2);
      assert.match(await p2.getByTestId("history-counts").innerText(), /0|No chats/i);
      await go("backup", p2);
      await pick(text, p2); // leaving the page forgets the chosen file
      await p2.getByTestId("backup-valid").waitFor();
      await p2.getByRole("checkbox", { name: /Also restore my preferences/ }).check();
      await planShows("plan-preferences", /setting\(s\) would change/, p2);
      await p2.getByRole("button", { name: "Restore…" }).click(); // the button says Restore, not Import, once something is overwritten
      // Replacing the preferences that are set now counts as overwriting: it needs the stronger confirmation.
      assert.match(await p2.getByTestId("restore-confirm").innerText(), /Your current preferences will be replaced by the backup's/);
      assert.equal(await p2.getByRole("button", { name: "Restore now" }).isDisabled(), true);
      await p2.getByRole("checkbox", { name: /Download a backup of my current data first/ }).uncheck();
      await p2.getByRole("checkbox", { name: /I understand/ }).check();
      await p2.getByRole("button", { name: "Restore now" }).click();
      await p2.getByTestId("restore-result").waitFor();
      assert.match(await p2.getByTestId("restore-result").innerText(), /Restore finished: 1 chat added, 1 file added, 1 skipped, preferences restored/);
      await go("chat", p2);
      assert.equal((await storedChats(p2)).length, 1);
      await p2.getByRole("button", { name: "Open workspace" }).click();
      assert.deepEqual(await fileNamesOf(p2), ["main.lua", "shop.lua"]);
      await p2.locator('[data-testid="file-row"][data-name="shop.lua"] button').first().click();
      assert.equal(await editor(p2).inputValue(), "print('v2 unsaved draft')", "the unsaved edit came back too");
      assert.doesNotMatch(await p2.evaluate(() => document.documentElement.className), /dark/, "preferences restored");
      await open("view:workspace", p2); // a fresh page load
      await p2.getByTestId("workspace").waitFor();
      assert.deepEqual(await fileNamesOf(p2), ["main.lua", "shop.lua"], "really stored, not only in memory");
    } finally {
      await fresh.close();
    }
  });

  it("merge never overwrites: a different local file is kept and the backup's copy is added next to it", async () => {
    await seed();
    const { text } = await download();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await editor().fill("print('my newer local version')");
    await editor().press("Control+S");
    await page.getByTestId("saved-badge").waitFor();
    await go("backup");
    await pick(text);
    await page.getByTestId("backup-valid").waitFor();
    assert.match(await page.getByTestId("plan-files").innerText(), /1 differ: the backup's version is added next to yours/);
    assert.match(await page.getByTestId("plan-chats").innerText(), /1 already identical/);
    await page.getByRole("button", { name: "Import…" }).click();
    assert.doesNotMatch(await confirmText(), /delete or overwrite/);
    await page.getByRole("button", { name: "Import now" }).click();
    await page.getByText(/Restore finished: 0 chats added, 1 file added/).waitFor();
    await page.getByRole("button", { name: "Open workspace" }).click();
    assert.deepEqual(await fileNamesOf(), ["main.lua", "shop.lua", "shop_2.lua"]);
    await page.locator('[data-testid="file-row"][data-name="shop.lua"] button').first().click();
    assert.equal(await editor().inputValue(), "print('my newer local version')");
    // The same backup again must not create yet another copy.
    await go("backup");
    await pick(text);
    await page.getByTestId("nothing-to-do").waitFor();
    assert.equal(await page.getByRole("button", { name: "Import…" }).isDisabled(), true);
  });

  it("'keep mine' ignores conflicts; 'replace mine' and 'replace everything' need an explicit second confirmation", async () => {
    await seed();
    const { text } = await download();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await editor().fill("print('local change')");
    await editor().press("Control+S");
    await page.getByTestId("saved-badge").waitFor();
    await go("backup");
    await pick(text);
    await page.getByTestId("backup-valid").waitFor();

    await page.getByLabel("If an item exists in both but differs:").selectOption("skip");
    await planShows("plan-files", /yours are kept, the backup's are ignored/);
    assert.equal(await page.getByRole("button", { name: "Import…" }).isDisabled(), true, "nothing to import");

    await page.getByLabel("If an item exists in both but differs:").selectOption("replace");
    await planShows("plan-files", /1 of yours will be deleted/);
    await page.getByRole("button", { name: "Restore…" }).click();
    assert.match(await confirmText(), /delete or overwrite data/);
    assert.equal(await page.getByRole("button", { name: "Restore now" }).isDisabled(), true, "needs the 'I understand' box");
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page.locator('[data-testid="file-row"][data-name="shop.lua"] button').first().click();
    assert.equal(await editor().inputValue(), "print('local change')", "cancel changed nothing");

    await go("backup");
    await pick(text); // leaving the page forgets the chosen file
    await page.getByTestId("backup-valid").waitFor();
    await page.getByLabel("If an item exists in both but differs:").selectOption("replace");
    await page.getByRole("button", { name: "Restore…" }).click();
    await page.getByRole("checkbox", { name: /Download a backup of my current data first/ }).uncheck();
    await page.getByRole("checkbox", { name: /I understand/ }).check();
    await page.getByRole("button", { name: "Restore now" }).click();
    await page.getByText(/Restore finished/).waitFor();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await page.locator('[data-testid="file-row"][data-name="shop.lua"] button').first().click();
    assert.equal(await editor().inputValue(), "print('v2 unsaved draft')", "replaced by the backup's version");
    assert.deepEqual(await fileNamesOf(), ["main.lua", "shop.lua"]);
  });

  it("'replace everything' offers a safety download of the current data first, then makes the data match the backup", async () => {
    await seed();
    const { text } = await download();
    await page.getByRole("button", { name: "Open workspace" }).click();
    await newFile("extra");
    await editor().fill("print('only here')");
    await editor().press("Control+S");
    await page.getByTestId("saved-badge").waitFor();
    await go("chat");
    await page.getByRole("button", { name: "Open chat" }).click();
    await page.getByRole("button", { name: "New Chat" }).first().click();
    await sendChat("a chat that is not in the backup");
    await go("backup");
    await pick(text);
    await page.getByTestId("backup-valid").waitFor();
    await page.getByRole("radio", { name: /Replace everything/ }).check();
    await planShows("plan-chats", /1 of yours will be deleted/);
    await planShows("plan-files", /1 of yours will be deleted/);
    await page.getByRole("button", { name: "Restore…" }).click();
    assert.match(await confirmText(), /Your 2 chats and 3 files will be replaced by the backup's 1 chat and 2 files/);
    await page.getByRole("checkbox", { name: /I understand/ }).check();
    const safety = await readDownload(() => page.getByRole("button", { name: "Restore now" }).click());
    assert.match(safety.name, /^gtps-assistant-before-restore-/);
    const { parseBackup } = await import("@/lib/backup/format");
    const before = await parseBackup(safety.text);
    assert.deepEqual(before.summary, { conversations: 2, messages: 4, files: 3 }, "the safety copy holds what was there before");
    await page.getByTestId("restore-result").waitFor();
    assert.match(await page.getByTestId("restore-result").innerText(), /1 chat added.*2 files added|2 removed/);
    await go("chat");
    assert.equal((await storedChats()).length, 1);
    await page.getByRole("button", { name: "Open workspace" }).click();
    assert.deepEqual(await fileNamesOf(), ["main.lua", "shop.lua"]);
  });
});

describe("local data", () => {
  it("clearing local data also resets the saved preferences", async () => {
    await open("appearance");
    await page.getByRole("switch", { name: "Dark mode" }).click();
    assert.equal((await prefs())?.theme, "light");
    await go("local-data");
    page.once("dialog", (d) => void d.accept());
    await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "Clear data" }).click()]);
    await page.locator("[data-page-content]").waitFor();
    assert.equal(await saved("gtps-assistant:prefs"), null);
    assert.match((await html()).cls, /dark/);
  });
});
