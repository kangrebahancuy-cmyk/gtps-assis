/**
 * What a person sees when the interface is served by a host that cannot run the backend (the Vercel case): the
 * real settings panels in real Chromium, in front of the REAL hosting guard (src/server/hosting.ts) answering
 * every /api call with 503, exactly as the middleware does there. Also the "database cannot be opened" case.
 *
 * The same stand-ins as settings.browser.ts apply (radix switch stub, no Tailwind). This does not run Next.js or
 * Vercel: it proves the browser side and the guard's answers, not that a Vercel deployment behaves this way.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, afterEach, describe, it } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright";

import { errorResponse, hostedApiResponse } from "../../src/server/hosting";
import { STORAGE_MESSAGE } from "../../src/lib/hosting";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

let site: TestSite;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let mode: "hosted" | "storage-broken" | "storage-fixed" = "hosted";
const calls: string[] = [];
const errors: string[] = [];

const VIEW = {
  settings: { sourceUrl: "https://dash.gtps.cloud/docs", websiteUrl: "https://gtps.cloud/", extraDomains: [] },
  approvedDomains: ["gtps.cloud"],
  defaults: { sourceUrl: "https://dash.gtps.cloud/docs", websiteUrl: "https://gtps.cloud/" },
  documents: 0,
  busy: false,
};

before(async () => {
  const css = ["layout.css", "workspace.css"].map((f) => readFileSync(join(ROOT, "tests/browser/support", f), "utf8")).join("\n");
  site = await serve(
    await bundle(join(ROOT, "tests/browser/entries/settings-app.tsx")),
    [
      async (req, res) => {
        if (!req.url?.startsWith("/api/")) return false;
        calls.push(`${req.method} ${req.url}`);
        const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method });
        let response: Response;
        if (mode === "hosted") response = hostedApiResponse(request, { VERCEL: "1" } as NodeJS.ProcessEnv) ?? Response.json({}, { status: 404 });
        else if (mode === "storage-broken") response = errorResponse(request, 503, "storage_unavailable", STORAGE_MESSAGE);
        else response = Response.json(VIEW);
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(await response.text());
        return true;
      },
    ],
    '<div id="root"></div>',
    css,
  );
  browser = await chromium.launch();
});
after(async () => {
  await browser.close();
  await site.close();
});
beforeEach(async () => {
  mode = "hosted";
  calls.length = 0;
  errors.length = 0;
  context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  context.setDefaultTimeout(6000);
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
});
afterEach(async () => {
  await context.close();
  assert.deepEqual(errors, []);
});

const open = async (pageId: string) => {
  await page.goto(`${site.origin}/?page=${pageId}`);
  await page.locator(`[data-page-content="${pageId}"]`).waitFor();
};
const bodyText = () => page.locator("main").innerText();

describe("a host without the backend", () => {
  it("AI Providers and Models say there is no local backend and why, never 'HTTP 500'", async () => {
    for (const id of ["providers", "models"]) {
      await open(id);
      await page.getByText("No local backend on this host").waitFor();
      const text = await bodyText();
      assert.match(text, /runs on your own computer/);
      assert.match(text, /Chats, the Lua workspace, preferences and backups still work here/);
      assert.doesNotMatch(text, /HTTP 5\d\d/);
    }
  });

  it("Documentation shows the explanation instead of 'Loading…' forever, with no useless retry button", async () => {
    await open("documentation");
    await page.getByTestId("docs-source-error").waitFor();
    const text = await page.getByTestId("docs-source-error").innerText();
    assert.match(text, /No local backend on this host/);
    assert.match(text, /no local backend/);
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0);
    assert.doesNotMatch(await bodyText(), /Loading…/);
  });

  it("Synchronization shows the explanation and leaves the buttons, not an endless 'Loading status…'", async () => {
    await open("synchronization");
    await page.getByText(/no local backend/).first().waitFor();
    assert.doesNotMatch(await bodyText(), /Loading status…/);
    assert.doesNotMatch(await bodyText(), /HTTP 5\d\d/);
  });

  it("Chat preferences: the default-model card explains, and the browser-side preferences still work", async () => {
    await open("chat");
    await page.getByTestId("chat-ai-unavailable").waitFor();
    assert.match(await page.getByTestId("chat-ai-unavailable").innerText(), /No local backend on this host/);
    const render = page.getByRole("switch", { name: "Render Markdown" });
    assert.equal(await render.getAttribute("aria-checked"), "true");
    await render.click();
    assert.equal(await render.getAttribute("aria-checked"), "false");
    await page.getByText(/chat\(s\), .* message\(s\) stored in this browser/).waitFor();
  });

  it("Appearance and Backup still work: dark mode is saved, and a backup downloads with no API keys", async () => {
    await open("appearance");
    const toggle = page.getByRole("switch", { name: "Dark mode" });
    const before = await toggle.getAttribute("aria-checked");
    await toggle.click();
    assert.notEqual(await toggle.getAttribute("aria-checked"), before);
    const stored = (await page.evaluate(() => JSON.parse(localStorage.getItem("gtps-assistant:prefs") ?? "null"))) as { prefs: { theme: string } };
    assert.equal(stored.prefs.theme, before === "true" ? "light" : "dark");
    await open("backup");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download backup" }).click()]);
    const text = readFileSync((await download.path()) as string, "utf8");
    const backup = JSON.parse(text) as { format: string; data: { preferences: unknown } };
    assert.equal(backup.format, "gtps-assistant-backup");
    assert.doesNotMatch(text, /AIza|gsk_|apiKey/);
  });

  it("Local Data still shows what this browser holds", async () => {
    await open("local-data");
    assert.match(await bodyText(), /Local Data|browser/i);
    assert.ok(calls.every((c) => c.startsWith("GET /api/") || c.startsWith("POST /api/")));
  });
});

describe("a computer whose database cannot be opened", () => {
  it("Documentation says what is wrong, offers 'Try again', and recovers once the problem is fixed", async () => {
    mode = "storage-broken";
    await open("documentation");
    await page.getByTestId("docs-source-error").waitFor();
    assert.match(await page.getByTestId("docs-source-error").innerText(), /could not open its database/);
    mode = "storage-fixed";
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByLabel("Documentation source URL").waitFor();
    assert.equal(await page.getByLabel("Documentation source URL").inputValue(), "https://dash.gtps.cloud/docs");
  });
});
