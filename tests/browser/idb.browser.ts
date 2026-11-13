/**
 * The IndexedDB repository in real Chromium: the shared repository contract,
 * atomic writes, and persistence across a page reload and a full browser restart.
 * Run with `npm run test:browser`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";

import { repositoryContract } from "../support/chat-repo-contract";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

let site: TestSite;
let browser: Browser;
let page: Page;

before(async () => {
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/idb-contract.ts")));
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(site.origin);
});
after(async () => {
  await browser.close();
  await site.close();
});

const call = <T,>(fn: string, ...args: unknown[]): Promise<T> => page.evaluate(([f, a]) => (window as any)[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;

describe("IndexedDB repository follows the repository contract (real Chromium)", () => {
  repositoryContract.forEach((c, index) =>
    it(c.name, async () => {
      const result = await call<{ ok: boolean; error?: string }>("runCase", index);
      assert.equal(result.ok, true, result.error);
    }),
  );
});

describe("IndexedDB repository behaviour", () => {
  it("a failed commit is rolled back completely", async () => {
    const r = await call<{ threw: boolean; title: string; ids: string[] }>("atomicity");
    assert.deepEqual(r, { threw: true, title: "before", ids: ["a-m0"] });
  });
  it("reports clearly when IndexedDB is unavailable", async () => {
    assert.match(await call<string>("unavailable"), /not available/);
  });
  it("data survives a page reload", async () => {
    await call("wipe");
    await call("writeData");
    await page.reload();
    const data = await call<{ conversations: Array<{ id: string; title: string }>; messages: Array<{ content: string }>; meta: string }>("readData");
    assert.deepEqual([data.conversations[0]?.id, data.conversations[0]?.title, data.messages[0]?.content, data.messages.length, data.meta], ["keep", "Survives", "héllo 🙂", 2, "keep"]);
  });
  it("data survives closing and restarting the browser (persistent profile)", async () => {
    const profile = mkdtempSync(join(tmpdir(), "gtps-profile-"));
    try {
      const first = await chromium.launchPersistentContext(profile);
      const p1 = await first.newPage();
      await p1.goto(site.origin);
      await p1.evaluate(() => (window as any).writeData());
      await first.close();

      const second = await chromium.launchPersistentContext(profile);
      const p2 = await second.newPage();
      await p2.goto(site.origin);
      const data = (await p2.evaluate(() => (window as any).readData())) as { conversations: Array<{ title: string }>; messages: unknown[] };
      await second.close();
      assert.deepEqual([data.conversations[0]?.title, data.messages.length], ["Survives", 2]);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
