/**
 * The workspace's IndexedDB repository in real Chromium: the shared repository contract, and persistence across
 * a page reload and a full browser restart. Run with `npm run test:browser`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Browser, Page } from "playwright";

import { workspaceContract } from "../support/workspace-repo-contract";
import { bundle, chromium, ROOT, serve, type TestSite } from "./support/browser";

let site: TestSite;
let browser: Browser;
let page: Page;

before(async () => {
  site = await serve(await bundle(join(ROOT, "tests/browser/entries/workspace-idb-contract.ts")));
  browser = await chromium.launch();
  page = await browser.newPage();
  await page.goto(site.origin);
});
after(async () => {
  await browser.close();
  await site.close();
});

const call = <T,>(fn: string, ...args: unknown[]): Promise<T> => page.evaluate(([f, a]) => (window as any)[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const EXPECTED = { name: "Zażółć.lua", content: "héllo 🙂\n", draft: "unsaved ✓" };

describe("workspace IndexedDB repository follows the repository contract (real Chromium)", () => {
  workspaceContract.forEach((c, index) =>
    it(c.name, async () => {
      const result = await call<{ ok: boolean; error?: string }>("runCase", index);
      assert.equal(result.ok, true, result.error);
    }),
  );
});

describe("workspace IndexedDB repository behaviour", () => {
  it("reports clearly when IndexedDB is unavailable", async () => {
    assert.match(await call<string>("unavailable"), /not available/);
  });
  it("deleteWorkspaceDatabase (Clear local data) removes everything, even while the database is open", async () => {
    assert.deepEqual(await call("clearWhileOpen"), { files: 0, seeded: null });
  });
  it("data survives a page reload", async () => {
    await call("wipe");
    await call("writeData");
    await page.reload();
    const data = await call<{ files: Array<{ name: string; content: string; draft: string }>; tabs: string }>("readData");
    assert.deepEqual({ ...data.files[0]!, id: undefined, createdAt: undefined, updatedAt: undefined }, { ...EXPECTED, id: undefined, createdAt: undefined, updatedAt: undefined });
    assert.equal(data.tabs, '["keep"]');
  });
  it("data survives closing and restarting the browser (persistent profile)", async () => {
    const profile = mkdtempSync(join(tmpdir(), "gtps-ws-profile-"));
    try {
      const first = await chromium.launchPersistentContext(profile);
      const p1 = await first.newPage();
      await p1.goto(site.origin);
      await p1.evaluate(() => (window as any).writeData());
      await first.close();

      const second = await chromium.launchPersistentContext(profile);
      const p2 = await second.newPage();
      await p2.goto(site.origin);
      const data = (await p2.evaluate(() => (window as any).readData())) as { files: Array<{ name: string; draft: string }> };
      await second.close();
      assert.deepEqual([data.files[0]?.name, data.files[0]?.draft], [EXPECTED.name, EXPECTED.draft]);
    } finally {
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
