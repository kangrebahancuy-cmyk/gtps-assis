/**
 * The Lua workspace in real Chromium: real React components, real IndexedDB, real controller, real AI backend
 * (request analysis, documentation retrieval over SQLite, script check) in front of local fake Gemini/Groq servers.
 *
 * Stand-ins, stated plainly:
 *  - Monaco: NOT installed here and it cannot be downloaded. The "monaco" engine in these tests is a textarea that
 *    implements the Monaco API subset the adapter calls (tests/browser/support/monaco-react-stub.tsx). It proves the
 *    wiring (file switching, selection, applying edits, markers, find actions, Ctrl+S). It does not prove that real
 *    Monaco highlights Lua or that its find widget works.
 *  - The basic (textarea) editor is the real fallback and is tested as itself.
 *  - Tailwind is not available: tests/browser/support/{layout,workspace}.css supply the layout utilities, so nothing
 *    here says how the page really looks.
 * Run with `npm run test:browser`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Browser, BrowserContext, Locator, Page } from "playwright";

import { lastGroqMessages, startBackend, type Backend } from "../support/backend";
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
  const css = readFileSync(join(ROOT, "tests/browser/support/layout.css"), "utf8") + readFileSync(join(ROOT, "tests/browser/support/workspace.css"), "utf8");
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/workspace-app.tsx")), [(req, res) => be.http(req, res)], '<div id="root"></div>', css);
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
  context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true, viewport: { width: 1280, height: 720 } });
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

type Engine = "monaco" | "basic";
const open = async (engine: Engine | "fail" | "hang" = "monaco", query = "") => {
  await be.configure({ provider: "groq", model: "llama-demo-70b" });
  if (engine === "fail" || engine === "hang") await page.addInitScript((mode) => ((window as unknown as { __MONACO_MODE: string }).__MONACO_MODE = mode), engine);
  const params = new URLSearchParams(query);
  if (engine === "basic") params.set("engine", "basic");
  if (engine === "hang") params.set("timeout", "400");
  await page.goto(`${site.origin}/?${params}`);
  await page.getByTestId("workspace").waitFor();
  await page.locator('[data-editor-engine="monaco"], [data-editor-engine="basic"]').waitFor();
  await page.getByRole("tab", { name: /main\.lua|\.lua/ }).first().waitFor();
};
const reopen = async () => {
  await page.reload();
  await page.getByTestId("workspace").waitFor();
  await page.locator('[data-editor-engine="monaco"], [data-editor-engine="basic"]').waitFor();
};

const input = (): Locator => page.locator('[data-testid="basic-editor"], [data-testid="monaco-stub-input"]').first();
const value = () => input().inputValue();
const type = (text: string) => input().fill(text);
const settle = () => page.waitForTimeout(700); // drafts are written to storage 400 ms after typing stops
const tabs = () => page.getByRole("tab");
const tabNames = async () => (await tabs().allInnerTexts()).map((t) => t.trim());
const rows = () => page.getByTestId("file-row");
const rowNames = async () => (await rows().evaluateAll((els) => els.map((e) => e.getAttribute("data-name")))).sort();
const rowButton = (name: string) => page.locator(`[data-testid="file-row"][data-name="${name}"] button`).first();
const flash = () => page.getByTestId("flash");
const newFile = async (name: string) => {
  await page.getByRole("button", { name: "New file" }).first().click();
  const field = page.getByLabel("New file name");
  await field.fill(name);
  await field.press("Enter");
};
const idbFiles = () =>
  page.evaluate(
    () =>
      new Promise<Array<{ name: string; content: string; draft: string | null }>>((resolve, reject) => {
        const req = indexedDB.open("gtps-assistant-workspace");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const all = req.result.transaction("files").objectStore("files").getAll();
          all.onsuccess = () => {
            req.result.close();
            resolve(all.result);
          };
        };
      }),
  );
const select = (from: string, to: string) =>
  page.evaluate(
    ([a, b]) => {
      const el = document.querySelector<HTMLTextAreaElement>('[data-testid="basic-editor"], [data-testid="monaco-stub-input"]')!;
      const start = el.value.indexOf(a!);
      const end = el.value.lastIndexOf(b!) + b!.length;
      el.focus();
      el.setSelectionRange(start, end);
    },
    [from, to],
  );

const CALLBACK = 'onPlayerCommandCallback(function(world, player, command, args)\n  if command == "hello" then\n    player:onConsoleMessage(greeting .. " " .. player:getName())\n    return true\n  end\n  return false\nend)';
const FILE = `local greeting = "Hello"\n\n${CALLBACK}\n`;
const reply = (code: string) => `## Script name\n\`hello_command.lua\`\n\n## Purpose\nGreets players.\n\n## Complete Lua code\n\n\`\`\`lua\n${code}\n\`\`\`\n\n## Usage instructions\nType /hello.\n\n## Known limitations\nNone.`;

describe("editor loading", () => {
  it("loads the Monaco adapter, with Lua, the dark theme, and the starter file", async () => {
    await open("monaco");
    assert.equal(await page.locator("[data-editor-engine]").getAttribute("data-editor-engine"), "monaco");
    assert.equal(await page.getByTestId("engine-label").innerText(), "Editor: Monaco");
    const stub = page.getByTestId("monaco-stub");
    assert.equal(await stub.getAttribute("data-language"), "lua");
    assert.equal(await stub.getAttribute("data-theme"), "vs-dark");
    assert.match(await value(), /^-- main\.lua\n/);
    assert.equal(await page.getByRole("tab", { selected: true }).count(), 1);
    assert.equal(await page.evaluate(() => (window as never as { __monaco: { loadCalls: number } }).__monaco.loadCalls), 1);
    assert.equal(await page.getByTestId("engine-notice").count(), 0, "no fallback notice when Monaco loads");
    assert.equal(await page.getByTestId("storage-label").innerText(), "Stored on this device (IndexedDB)");
  });

  it("falls back to the basic editor, and says why, when Monaco cannot be downloaded", async () => {
    await open("fail");
    assert.equal(await page.locator("[data-editor-engine]").getAttribute("data-editor-engine"), "basic");
    assert.equal(await page.getByTestId("engine-label").innerText(), "Editor: basic");
    assert.match(await page.getByTestId("engine-notice").innerText(), /basic editor \(no syntax colouring\).*Could not download Monaco/);
    await type("print('works without Monaco')");
    assert.equal(await value(), "print('works without Monaco')");
    assert.equal(await page.getByTestId("unsaved-badge").count(), 1);
  });

  it("falls back when Monaco takes too long", async () => {
    await open("hang");
    assert.match(await page.getByTestId("engine-notice").innerText(), /did not load in time/);
    assert.equal(await page.locator("[data-editor-engine]").getAttribute("data-editor-engine"), "basic");
  });
});

describe("basic editor", () => {
  it("shows line numbers, indents with Tab, and has its own find and replace", async () => {
    await open("basic");
    await type("a = 1\nb = 2\nc = 1");
    assert.deepEqual((await page.getByTestId("line-numbers").innerText()).split("\n").filter(Boolean), ["1", "2", "3"]);
    await type("a = 1\nb = 2\nc = 1\nd = 1");
    assert.equal((await page.getByTestId("line-numbers").innerText()).split("\n").filter(Boolean).length, 4);

    await input().press("Control+Home");
    await input().press("Tab");
    assert.equal((await value()).split("\n")[0], "  a = 1");

    await input().press("Control+h");
    await page.getByLabel("Find", { exact: true }).fill("= 1");
    assert.equal(await page.getByTestId("find-count").innerText(), "3 matches");
    await page.getByLabel("Replace with").fill("= 9");
    await page.getByRole("button", { name: "Next match" }).click();
    assert.equal(await input().evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd)), "= 1");
    await page.getByRole("search").getByRole("button", { name: "Replace", exact: true }).click();
    assert.equal(await value(), "  a = 9\nb = 2\nc = 1\nd = 1");
    await page.getByRole("button", { name: "Replace all" }).click();
    assert.equal(await value(), "  a = 9\nb = 2\nc = 9\nd = 9");
    assert.equal(await page.getByTestId("find-count").innerText(), "0 matches");
    await page.getByLabel("Find", { exact: true }).press("Escape");
    assert.equal(await page.getByRole("search").count(), 0);
  });

  it("the toolbar Find and Replace buttons open the same bar (basic) or ask Monaco for its widget (adapter)", async () => {
    await open("basic");
    await page.getByRole("button", { name: "Find", exact: true }).click();
    assert.equal(await page.getByLabel("Replace with").count(), 0, "Find has no replace field");
    await page.getByRole("button", { name: "Close find" }).click();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    assert.equal(await page.getByLabel("Replace with").count(), 1);

    await page.goto("about:blank");
    await open("monaco");
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await page.getByRole("button", { name: "Replace", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => (window as never as { __monaco: { actions: string[] } }).__monaco.actions), ["actions.find", "editor.action.startFindReplace"]);
  });
});

describe("saving and the unsaved indicator", () => {
  for (const engine of ["monaco", "basic"] as const) {
    it(`${engine}: editing marks the file unsaved (tab dot, badge); Save and Ctrl+S clear it and store the text`, async () => {
      await open(engine);
      assert.equal(await page.getByTestId("saved-badge").innerText(), "All changes saved");
      assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);

      await type("print('v1')");
      assert.equal(await page.getByTestId("unsaved-badge").innerText(), "Unsaved changes");
      assert.equal(await page.getByTestId("unsaved-dot").count(), 1);
      assert.equal(await page.getByTestId("explorer-unsaved").count(), 1);
      assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);

      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTestId("saved-badge").waitFor();
      assert.equal(await page.getByTestId("unsaved-dot").count(), 0);
      assert.equal(await flash().innerText(), "Saved main.lua");
      const stored = (await idbFiles()).find((f) => f.name === "main.lua")!;
      assert.deepEqual({ content: stored.content, draft: stored.draft }, { content: "print('v1')", draft: null });

      await type("print('v2')");
      await input().press("Control+s");
      await page.getByTestId("saved-badge").waitFor();
      assert.equal((await idbFiles()).find((f) => f.name === "main.lua")!.content, "print('v2')");

      await type("print('v3')");
      await page.getByRole("button", { name: "Revert" }).click();
      assert.equal(await value(), "print('v2')");
      assert.equal(await page.getByTestId("unsaved-dot").count(), 0);
    });
  }

  it("typing back to the saved text clears the unsaved mark", async () => {
    await open("basic");
    const original = await value();
    await type(`${original}x`);
    assert.equal(await page.getByTestId("unsaved-dot").count(), 1);
    await type(original);
    assert.equal(await page.getByTestId("unsaved-dot").count(), 0);
  });
});

describe("file management", () => {
  it("creates files (unique names), opens them in tabs, renames (with errors) and deletes (with confirmation)", async () => {
    await open("basic");
    await newFile("Shop Items");
    assert.deepEqual(await rowNames(), ["main.lua", "shop_items.lua"]);
    assert.equal(await page.getByRole("tab", { selected: true }).innerText(), "shop_items.lua");
    assert.equal(await value(), "", "a new file is empty");
    await newFile("shop items");
    assert.deepEqual(await rowNames(), ["main.lua", "shop_items.lua", "shop_items_2.lua"]);
    assert.equal((await tabNames()).length, 3);

    await page.getByRole("button", { name: "Rename shop_items_2.lua" }).click();
    const field = page.getByLabel("Rename shop_items_2.lua");
    await field.fill("main.lua");
    await field.press("Enter");
    assert.match(await page.getByRole("alert").innerText(), /already exists/);
    await field.fill("Daily Reward");
    await field.press("Enter");
    assert.deepEqual(await rowNames(), ["daily_reward.lua", "main.lua", "shop_items.lua"]);
    assert.deepEqual(await tabNames(), ["main.lua", "shop_items.lua", "daily_reward.lua"]);

    await page.getByRole("button", { name: "Delete shop_items.lua" }).click();
    await page.getByRole("button", { name: "Cancel" }).click();
    assert.equal((await rowNames()).length, 3, "cancel keeps the file");
    await page.getByRole("button", { name: "Delete shop_items.lua" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    assert.deepEqual(await rowNames(), ["daily_reward.lua", "main.lua"]);
    assert.deepEqual(await tabNames(), ["main.lua", "daily_reward.lua"]);
    await settle();
    assert.deepEqual((await idbFiles()).map((f) => f.name).sort(), ["daily_reward.lua", "main.lua"]);
  });

  it("opening the last file shows an empty state with a New file button", async () => {
    await open("basic");
    await page.getByRole("button", { name: "Delete main.lua" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByText("No file is open.").waitFor();
    await page.getByTestId("editor-area").getByRole("button", { name: "New file" }).click();
    assert.deepEqual(await rowNames(), ["untitled.lua"]);
  });
});

describe("multiple tabs", () => {
  for (const engine of ["monaco", "basic"] as const) {
    it(`${engine}: each tab keeps its own text; closing a tab keeps unsaved edits in the file list`, async () => {
      await open(engine);
      await type("-- first");
      await newFile("second");
      await type("-- second");
      await newFile("third");
      await type("-- third");
      assert.deepEqual(await tabNames(), ["main.lua", "second.lua", "third.lua"]);

      await page.getByRole("tab", { name: "main.lua" }).click();
      assert.equal(await value(), "-- first");
      await page.getByRole("tab", { name: "second.lua" }).click();
      assert.equal(await value(), "-- second");
      assert.equal(await page.getByRole("tab", { selected: true }).innerText(), "second.lua");

      await page.getByRole("button", { name: "Close second.lua" }).click();
      assert.deepEqual(await tabNames(), ["main.lua", "third.lua"]);
      assert.equal(await page.getByRole("tab", { selected: true }).innerText(), "third.lua", "the neighbouring tab becomes active");
      assert.equal(await page.locator('[data-testid="file-row"][data-name="second.lua"] [data-testid="explorer-unsaved"]').count(), 1, "the closed file is still unsaved");
      await rowButton("second.lua").click();
      assert.equal(await value(), "-- second", "reopening shows the unsaved text");
      assert.equal(await page.getByTestId("unsaved-dot").count(), 3);

      if (engine === "monaco") {
        const paths = await page.evaluate(() => (window as never as { __monaco: { paths: string[] } }).__monaco.paths);
        assert.equal(new Set(paths).size, 3, "the adapter gives Monaco one path (one model and undo history) per file");
        assert.equal(await page.evaluate(() => (window as never as { __monaco: { mounts: number } }).__monaco.mounts), 1, "one editor instance serves every tab");
      }
    });
  }
});

describe("selection, copy, download", () => {
  it("Copy copies the selection, or the whole file when nothing is selected", async () => {
    await open("basic");
    await type(FILE);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.getByText("Copied the whole file").waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), FILE);

    await select('local greeting = "Hello"', 'local greeting = "Hello"');
    await page.getByTestId("selection-info").waitFor();
    assert.equal(await page.getByTestId("selection-info").innerText(), `${'local greeting = "Hello"'.length} characters selected`);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.getByText(/Copied the selection/).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'local greeting = "Hello"');
  });

  it("the adapter reports the selection (offsets and text) from Monaco's model", async () => {
    await open("monaco");
    await type(FILE);
    await select("onPlayerCommandCallback", "return true");
    await page.getByTestId("selection-info").waitFor();
    const expected = FILE.slice(FILE.indexOf("onPlayerCommandCallback"), FILE.lastIndexOf("return true") + "return true".length);
    assert.equal(await page.getByTestId("selection-info").innerText(), `${expected.length} characters selected`);
    await page.getByRole("button", { name: "Copy", exact: true }).click();
    await page.getByText(/Copied the selection/).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
  });

  it("Download .lua gives the file as it is in the editor, unsaved edits included", async () => {
    await open("basic");
    await newFile("Daily Reward");
    await type("-- unsaved but downloaded\nprint(1)\n");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download .lua" }).click()]);
    assert.equal(download.suggestedFilename(), "daily_reward.lua");
    assert.equal(readFileSync((await download.path())!, "utf8"), "-- unsaved but downloaded\nprint(1)\n");
    assert.match(await flash().innerText(), /Downloaded daily_reward\.lua \(including unsaved changes\)/);
  });
});

describe("import and export", () => {
  it("Import opens a file chooser; .lua files are added next to existing ones (never overwriting); bad files are reported", async () => {
    await open("basic");
    await type("-- mine");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Import", exact: true }).click()]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles([
      { name: "main.lua", mimeType: "text/plain", buffer: Buffer.from("﻿-- imported main\r\nprint(1)\r\n") },
      { name: "Extra Script.lua", mimeType: "text/plain", buffer: Buffer.from("print('extra')") },
      { name: "photo.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71]) },
      { name: "binary.lua", mimeType: "text/plain", buffer: Buffer.from([112, 0, 113]) },
    ]);
    await page.getByTestId("import-errors").waitFor();
    const errorsText = await page.getByTestId("import-errors").innerText();
    assert.match(errorsText, /photo\.png: only \.lua/);
    assert.match(errorsText, /binary\.lua: looks like a binary file/);
    assert.deepEqual(await rowNames(), ["extra_script.lua", "main.lua", "main_2.lua"]);
    assert.equal(await page.getByRole("tab", { selected: true }).innerText(), "extra_script.lua");
    await page.getByRole("tab", { name: "main_2.lua" }).click();
    assert.equal(await value(), "-- imported main\nprint(1)\n", "BOM removed, CRLF turned into LF");
    await page.getByRole("tab", { name: "main.lua", exact: true }).click();
    assert.equal(await value(), "-- mine", "the existing file was not overwritten");
    await settle();
    assert.deepEqual((await idbFiles()).map((f) => f.name).sort(), ["extra_script.lua", "main.lua", "main_2.lua"]);
    await page.getByRole("button", { name: "Dismiss" }).click();
    assert.equal(await page.getByTestId("import-errors").count(), 0);
  });

  it("rejects a Lua file over 1 MB", async () => {
    await open("basic");
    await page.getByTestId("import-input").setInputFiles({ name: "huge.lua", mimeType: "text/plain", buffer: Buffer.alloc(1024 * 1024 + 1, 97) });
    assert.match(await page.getByTestId("import-errors").innerText(), /huge\.lua: too large/);
    assert.deepEqual(await rowNames(), ["main.lua"]);
  });

  it("Export project downloads every file, and Import project restores them in another browser profile", async () => {
    await open("basic");
    await type("-- main text");
    await newFile("quest");
    await type("-- quest text (unsaved)");
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export project" }).click()]);
    assert.equal(download.suggestedFilename(), "gtps-lua-project.json");
    const text = readFileSync((await download.path())!, "utf8");
    const project = JSON.parse(text) as { format: string; version: number; files: Array<{ name: string; content: string }> };
    assert.deepEqual({ format: project.format, version: project.version }, { format: "gtps-lua-workspace", version: 1 });
    assert.deepEqual(project.files.map((f) => [f.name, f.content]), [["main.lua", "-- main text"], ["quest.lua", "-- quest text (unsaved)"]]);

    await context.close();
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    context.setDefaultTimeout(5000);
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    await open("basic");
    await page.getByTestId("import-project-input").setInputFiles({ name: "gtps-lua-project.json", mimeType: "application/json", buffer: Buffer.from(text) });
    await page.getByText("Imported 2 files from the project").waitFor();
    assert.deepEqual(await rowNames(), ["main.lua", "main_2.lua", "quest.lua"], "existing files are not overwritten");
    await page.getByRole("tab", { name: "quest.lua" }).click();
    assert.equal(await value(), "-- quest text (unsaved)");

    await page.getByTestId("import-project-input").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"nope":1}') });
    assert.match(await page.getByTestId("import-errors").innerText(), /not a GTPS Lua workspace project file/);
  });
});

describe("persistence after reload", () => {
  it("files, saved text, unsaved drafts, open tabs and the active tab all survive a reload (stored in IndexedDB)", async () => {
    await open("monaco");
    await type("-- main saved");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await newFile("second");
    await type("-- second saved");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await type("-- second DRAFT, not saved");
    await newFile("third");
    await type("-- third draft");
    await page.getByRole("button", { name: "Close third.lua" }).click();
    await page.getByRole("tab", { name: "second.lua" }).click();
    await settle();

    const stored = await idbFiles();
    assert.deepEqual(stored.map((f) => [f.name, f.content, f.draft]).sort(), [
      ["main.lua", "-- main saved", null],
      ["second.lua", "-- second saved", "-- second DRAFT, not saved"],
      ["third.lua", "", "-- third draft"],
    ]);

    await reopen();
    assert.deepEqual(await rowNames(), ["main.lua", "second.lua", "third.lua"]);
    assert.deepEqual(await tabNames(), ["main.lua", "second.lua"], "third.lua stayed closed");
    assert.equal(await page.getByRole("tab", { selected: true }).innerText(), "second.lua");
    assert.equal(await value(), "-- second DRAFT, not saved");
    assert.equal(await page.getByTestId("unsaved-badge").count(), 1, "still marked unsaved after the reload");
    await page.getByRole("tab", { name: "main.lua" }).click();
    assert.equal(await value(), "-- main saved");
    assert.equal(await page.getByTestId("saved-badge").count(), 1);
    await rowButton("third.lua").click();
    assert.equal(await value(), "-- third draft");

    await page.getByRole("tab", { name: "second.lua" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByTestId("saved-badge").waitFor(); // the badge appears once the write has reached IndexedDB
    await reopen();
    await page.getByRole("tab", { name: "second.lua" }).click();
    assert.equal(await value(), "-- second DRAFT, not saved");
    assert.equal(await page.getByTestId("saved-badge").count(), 1, "saved after the reload");
  });

  it("renames and deletions persist, and the starter file does not come back after it is deleted", async () => {
    await open("basic");
    await newFile("temp");
    await page.getByRole("button", { name: "Rename temp.lua" }).click();
    await page.getByLabel("Rename temp.lua").fill("final");
    await page.getByLabel("Rename temp.lua").press("Enter");
    await page.getByRole("button", { name: "Delete main.lua" }).click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await settle();
    await reopen();
    assert.deepEqual(await rowNames(), ["final.lua"]);
    assert.deepEqual(await tabNames(), ["final.lua"]);
  });

  it("migrates scripts from the old localStorage workspace once, ignoring its two placeholder files", async () => {
    await page.addInitScript(() => {
      if (localStorage.getItem("migrated-once")) return;
      localStorage.setItem("migrated-once", "1");
      localStorage.setItem(
        "gtps-assistant:workspace",
        JSON.stringify({ state: { files: [{ id: "1", name: "main.lua", content: "-- main.lua\n-- Workspace placeholder. Write your Lua here.\n" }, { id: "2", name: "scratch.lua", content: "-- scratch.lua\n" }, { id: "3", name: "hello_command.lua", content: "print('from step 8')\n" }] }, version: 0 }),
      );
    });
    await open("basic");
    assert.deepEqual(await rowNames(), ["hello_command.lua"]);
    assert.equal(await value(), "print('from step 8')\n");
    await reopen();
    assert.deepEqual(await rowNames(), ["hello_command.lua"], "not imported a second time");
  });
});

describe("syntax checking is syntax only", () => {
  it("lists syntax errors with line and column, marks them in the editor, and says what the check is not", async () => {
    await open("monaco");
    await type("local x = 1\nif x then\n  print(x)\n");
    await page.getByTestId("syntax-problem").waitFor();
    const problem = await page.getByTestId("syntax-problem").innerText();
    assert.match(problem, /4:\d+\s+'end' expected \(to close 'if' at line 2\) near <eof>/);
    assert.match(await page.getByTestId("syntax-status-bar").innerText(), /^Syntax error at line 4/);
    const markers = await page.evaluate(() => (window as never as { __monaco: { markers: Record<string, Array<{ startLineNumber: number; severity: number; message: string }>> } }).__monaco.markers["gtps-syntax"]);
    assert.equal(markers?.length, 1);
    assert.deepEqual({ line: markers![0]!.startLineNumber, severity: markers![0]!.severity }, { line: 4, severity: 8 });
    assert.deepEqual(await page.evaluate(() => (window as never as { __monaco: { eolCalls: number[] } }).__monaco.eolCalls.every((n) => n === 0)), true, "the model is kept on LF line endings");

    await page.getByTestId("syntax-problem").click();
    await type("local x = 1\nif x then\n  print(x)\nend\n");
    await page.getByTestId("syntax-clean").waitFor();
    assert.equal(await page.getByTestId("syntax-clean").innerText(), "No syntax errors found");
    const markersAfter = await page.evaluate(() => (window as never as { __monaco: { markers: Record<string, unknown[]> } }).__monaco.markers["gtps-syntax"]);
    assert.equal(markersAfter?.length, 0, "markers are cleared");

    const everything = await page.getByTestId("workspace").innerText();
    assert.match(await page.getByTestId("syntax-scope").innerText(), /does not run the script.*not GTPS runtime validation/);
    assert.match(await page.getByTestId("runtime-scope").innerText(), /GTPS runtime: not validated.*never executed/);
    assert.doesNotMatch(everything, /works in GTPS|is valid|valid Lua|will work|check passed|\bpassed\b/i, "a clean syntax check never claims the script works");
  });

  it("the basic editor marks the error line number in its gutter", async () => {
    await open("basic");
    await type("print(1)\nprint(2\n");
    await page.getByTestId("syntax-problem").waitFor();
    assert.equal(await page.getByTestId("line-numbers").locator("div.font-bold").count(), 1);
  });

  it("clicking a problem moves the cursor to it (basic editor)", async () => {
    await open("basic");
    await type("print(1)\nprint(2\nprint(3)");
    await page.getByTestId("syntax-problem").waitFor();
    await page.getByTestId("syntax-problem").click();
    const caret = await input().evaluate((el: HTMLTextAreaElement) => el.value.slice(0, el.selectionStart).split("\n").length);
    assert.equal(caret, 3, "the parser reports the error at the next token (line 3)");
  });

  it("'Check against documentation' reads the code against the indexed docs, never claims it works, and goes stale when the code changes", async () => {
    await open("basic");
    await type(FILE);
    await page.getByRole("button", { name: "Check against documentation" }).click();
    await page.getByTestId("docs-result").waitFor();
    const result = page.getByTestId("docs-result");
    assert.equal(await result.getAttribute("data-stale"), "false");
    const text = await result.innerText();
    assert.match(text, /no problems found/i);
    assert.match(text, /GTPS runtime: not validated/);
    assert.doesNotMatch(text, /\bpassed\b|valid Lua|is valid|will work|works in GTPS|is working/i);
    assert.match(await page.getByTestId("api-summary").innerText(), /\d+ documented/);
    await type(`${FILE}-- changed\n`);
    await page.waitForFunction(() => document.querySelector('[data-testid="docs-result"]')?.getAttribute("data-stale") === "true");
    assert.match(await result.innerText(), /The code changed after this check/);
  });

  it("flags an API call the documentation does not have", async () => {
    await open("basic");
    await type('onPlayerCommandCallback(function(world, player, command, args)\n  player:teleportToMoon("x")\n  return true\nend)\n');
    await page.getByRole("button", { name: "Check against documentation" }).click();
    await page.getByTestId("docs-result").waitFor();
    assert.match(await page.getByTestId("docs-result").innerText(), /teleportToMoon/);
    assert.match(await page.getByTestId("script-check").innerText(), /Script check found problems/);
  });
});

describe("full screen", () => {
  it("fills the window, keeps the editor and its text, and Esc leaves", async () => {
    await open("monaco");
    await type("-- keep me");
    const normal = await page.getByTestId("workspace").boundingBox();
    assert.ok(normal && normal.height <= 720 && normal.width <= 1100);
    await page.getByRole("button", { name: "Full screen" }).click();
    assert.equal(await page.getByTestId("workspace").getAttribute("data-fullscreen"), "true");
    const full = await page.getByTestId("workspace").boundingBox();
    assert.deepEqual({ x: full!.x, y: full!.y, w: full!.width, h: full!.height }, { x: 0, y: 0, w: 1280, h: 720 });
    assert.equal(await value(), "-- keep me");
    assert.equal(await page.evaluate(() => (window as never as { __monaco: { mounts: number } }).__monaco.mounts), 1, "the editor was not re-created");
    await page.getByRole("button", { name: "Exit full screen" }).waitFor();
    await input().press("Escape");
    assert.equal(await page.getByTestId("workspace").getAttribute("data-fullscreen"), "false");
    assert.equal(await value(), "-- keep me");
  });

  it("Esc inside the find bar closes the bar, not full screen", async () => {
    await open("basic");
    await page.getByRole("button", { name: "Full screen" }).click();
    await page.getByRole("button", { name: "Find", exact: true }).click();
    await page.getByLabel("Find", { exact: true }).press("Escape");
    assert.equal(await page.getByRole("search").count(), 0);
    assert.equal(await page.getByTestId("workspace").getAttribute("data-fullscreen"), "true");
  });
});

describe("storage that is not IndexedDB", () => {
  it("warns that files will not be kept, and asks the browser to confirm leaving while edits are unsaved", async () => {
    await page.addInitScript(() => Object.defineProperty(window, "indexedDB", { value: undefined, configurable: true }));
    await open("basic");
    assert.match(await page.getByTestId("storage-warning").innerText(), /not being stored on this device.*lost when this page closes/);
    assert.equal(await page.getByTestId("storage-label").innerText(), "Not stored (memory only)");
    const askedBefore = await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    assert.equal(askedBefore, false, "nothing unsaved: leaving is not blocked");
    await type("-- unsaved");
    const asked = await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
    assert.equal(asked, true, "unsaved edits that live only in memory: the browser is asked to confirm");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByTestId("saved-badge").waitFor();
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), false);
  });

  it("with IndexedDB there is no leave warning, because unsaved drafts are kept on this device", async () => {
    await open("basic");
    await type("-- unsaved");
    assert.equal(await page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), false);
  });
});

describe("AI assistant", () => {
  const MODIFIED = CALLBACK.replace("    return true", '    print("handled /hello")\n    return true');
  const openAi = async () => {
    await page.getByRole("button", { name: "AI", exact: true }).click();
    await page.getByTestId("ai-panel").waitFor();
  };
  const chooseAction = (name: string) => page.getByRole("group", { name: "AI action" }).getByRole("button", { name, exact: true }).click();
  const lastPrompt = () => lastGroqMessages(be.groq).at(-1)!.content;

  for (const engine of ["monaco", "basic"] as const) {
    it(`${engine}: Modify on a selection retrieves documentation, shows a diff and sources, applies only to the selection, and can be undone`, async () => {
      await open(engine);
      await type(FILE);
      await select("onPlayerCommandCallback", "end)");
      await openAi();
      await chooseAction("Modify");
      assert.match(await page.getByTestId("ai-scope").innerText(), /Works on the selection \(\d+ characters\)\. The GTPS documentation is searched for every request\./);

      await page.getByLabel("What should change?").fill("print a line when the hello command is handled");
      be.groq.setReply([reply(MODIFIED)]);
      await page.getByRole("button", { name: "Run: Modify" }).click();
      await page.getByTestId("ai-result").waitFor();

      // what the provider received: documentation excerpts, and the selection (not the whole file) as the script
      assert.match(lastPrompt(), /Indexed GTPS Cloud documentation excerpts/);
      assert.match(lastPrompt(), /Signature: onPlayerCommandCallback/);
      const asked = lastPrompt().slice(lastPrompt().indexOf("The code below is a SELECTED PART"));
      assert.match(asked, /print a line when the hello command is handled/);
      assert.doesNotMatch(asked.replace(/```text[\s\S]*?```/, ""), /local greeting/);

      // what the person sees
      assert.match(await page.getByTestId("diff-stats").innerText(), /\+1 −0 lines/);
      assert.equal(await page.locator('[data-diff="add"]').innerText(), '+     print("handled /hello")');
      assert.ok((await page.getByTestId("source-item").count()) > 0, "documentation sources are listed");
      assert.match(await page.getByTestId("script-check").innerText(), /Script check: no problems found/);
      assert.match(await page.getByTestId("selection-check-note").innerText(), /covers only the returned part/);
      assert.match(await page.getByTestId("ai-disclaimer").innerText(), /not tested on a GTPS server.*never run it/);
      assert.equal(await value(), FILE, "nothing changes until Apply");

      await page.getByRole("button", { name: "Replace selection" }).click();
      assert.equal(await value(), FILE.replace(CALLBACK, MODIFIED));
      assert.equal(await page.getByTestId("unsaved-badge").count(), 1, "applied text is unsaved until the person saves");
      await page.getByTestId("applied").waitFor();

      await page.getByRole("button", { name: "Undo", exact: true }).click();
      assert.equal(await value(), FILE);
      await page.getByRole("button", { name: "Replace selection" }).click();
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByTestId("saved-badge").waitFor();
      assert.equal((await idbFiles()).find((f) => f.name === "main.lua")!.content, FILE.replace(CALLBACK, MODIFIED));
    });
  }

  it("refuses to apply when the code changed after the request", async () => {
    await open("basic");
    await type(FILE);
    await select("onPlayerCommandCallback", "end)");
    await openAi();
    await chooseAction("Optimize");
    be.groq.setReply([reply(MODIFIED)]);
    await page.getByRole("button", { name: "Run: Optimize" }).click();
    await page.getByTestId("ai-result").waitFor();
    await type(FILE.replace('"Hello"', '"Goodbye"'));
    await page.getByRole("button", { name: "Replace selection" }).click();
    assert.match(await page.getByTestId("apply-error").innerText(), /changed after the request/);
    assert.equal(await value(), FILE.replace('"Hello"', '"Goodbye"'), "the newer edit was not overwritten");
  });

  it("Explain answers from the documentation without offering to change the code", async () => {
    await open("basic");
    await type(FILE);
    await openAi();
    await chooseAction("Explain");
    be.groq.setReply(["It registers a command handler [1] and answers `/hello`."]);
    await page.getByRole("button", { name: "Run: Explain" }).click();
    await page.getByTestId("ai-result").waitFor();
    assert.match(await page.getByTestId("ai-result").innerText(), /registers a command handler/);
    assert.equal(await page.getByRole("group", { name: "Apply the result" }).count(), 0);
    assert.match(lastPrompt(), /Indexed GTPS Cloud documentation excerpts/);
    assert.doesNotMatch(lastGroqMessages(be.groq)[0]!.content, /SCRIPT GENERATOR MODE/);
  });

  it("Generate from natural language: insert at the cursor, replace the file, or save as a new file", async () => {
    await open("basic");
    await type("-- header\n");
    await openAi();
    await chooseAction("Generate");
    await page.getByLabel("Describe the script you want").fill("Create a custom player command /hello");
    be.groq.setReply([reply(CALLBACK)]);
    await page.getByRole("button", { name: "Run: Generate" }).click();
    await page.getByTestId("ai-result").waitFor();
    assert.match(lastPrompt(), /Indexed GTPS Cloud documentation excerpts/);
    assert.match(lastPrompt(), /Create a custom player command \/hello/);
    assert.match(await page.getByTestId("generation-report").innerText(), /Request analysis|Documentation/i);

    await page.getByRole("button", { name: "Save as new file" }).click();
    await page.getByRole("tab", { name: "generated.lua" }).waitFor();
    assert.equal(await value(), `${CALLBACK}\n`);
    await page.getByRole("tab", { name: "main.lua" }).click();
    assert.equal(await value(), "-- header\n", "the original file is untouched");
    assert.equal(await page.getByRole("button", { name: "Insert at cursor" }).count(), 1);
    await input().press("Control+End");
    await page.getByRole("button", { name: "Insert at cursor" }).click();
    assert.equal(await value(), `-- header\n${CALLBACK}\n`, "inserted at the cursor, on its own lines");
    await page.getByRole("button", { name: "Replace whole file" }).click();
    assert.equal(await value(), `${CALLBACK}\n`);
  });

  it("Fix sends the local syntax error to the model, and a script that is cut off cannot be applied", async () => {
    await open("basic");
    await type("print(1)\nif true then\n  print(2)\n");
    await page.getByTestId("syntax-problem").waitFor();
    await openAi();
    await chooseAction("Fix");
    be.groq.setReply(["## Complete Lua code\n\n```lua\nprint(1)\nif true then\n  print("]);
    await page.getByRole("button", { name: "Run: Fix" }).click();
    await page.getByTestId("ai-result").waitFor();
    assert.match(lastPrompt(), /The local syntax check of the editor reports:\n- line 4: 'end' expected/);
    assert.match(await page.getByTestId("ai-incomplete").innerText(), /cut off.*incomplete/);
    assert.equal(await page.getByRole("button", { name: "Replace whole file" }).isDisabled(), true);
    assert.equal(await page.getByRole("button", { name: "Save as new file" }).isDisabled(), true);
  });

  it("shows provider errors and invalid requests clearly, with nothing applied", async () => {
    await open("basic");
    await openAi();
    await chooseAction("Modify");
    await type("print(1)");
    await page.getByRole("button", { name: "Run: Modify" }).click();
    assert.match(await page.getByTestId("ai-error").innerText(), /Say what should change first/);
    await page.getByLabel("What should change?").fill("make it louder");
    be.groq.queue({ status: 429, headers: { "retry-after": "90" }, body: JSON.stringify({ error: { message: "Rate limit reached" } }) });
    await page.getByRole("button", { name: "Run: Modify" }).click();
    await page.getByTestId("ai-error").filter({ hasText: /rate|limit|wait/i }).waitFor();
    assert.equal(await value(), "print(1)");
  });

  it("remembers the chosen provider and model across a reload", async () => {
    await open("basic");
    await openAi();
    await page.getByLabel("AI provider").waitFor();
    await page.getByLabel("AI provider").selectOption("groq");
    const model = await page.getByLabel("AI model").inputValue();
    assert.ok(model.length > 0);
    await settle();
    await reopen();
    await openAi();
    assert.equal(await page.getByLabel("AI provider").inputValue(), "groq");
    assert.equal(await page.getByLabel("AI model").inputValue(), model);
  });
});
