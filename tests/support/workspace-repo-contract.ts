/**
 * Behaviour every WorkspaceRepository must have. Run against the in-memory repository in Node
 * and against the real IndexedDB in Chromium (tests/browser/workspace-idb.browser.ts).
 */
import assert from "node:assert/strict";

import type { WorkspaceFile, WorkspaceRepository } from "@/lib/workspace/types";

export interface WorkspaceContractCase {
  name: string;
  run(repo: WorkspaceRepository): Promise<void>;
}

export const wfile = (id: string, over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  id,
  name: `${id}.lua`,
  content: `-- ${id}\n`,
  draft: null,
  createdAt: 100,
  updatedAt: 100,
  ...over,
});

const ids = (list: WorkspaceFile[]) => list.map((f) => f.id);

export const workspaceContract: WorkspaceContractCase[] = [
  {
    name: "starts empty",
    async run(repo) {
      assert.deepEqual(await repo.listFiles(), []);
      assert.equal(await repo.getMeta("tabs"), null);
    },
  },
  {
    name: "stores files with every field and lists them oldest first",
    async run(repo) {
      const a = wfile("a", { createdAt: 30, draft: "-- unsaved\n", updatedAt: 31 });
      const b = wfile("b", { createdAt: 10 });
      const c = wfile("c", { createdAt: 20, name: "Ünï cødé.lua", content: "Zażółć gęślą jaźń 🙂\nprint(\"x\")\r\n" });
      await repo.putFiles([a, b, c]);
      assert.deepEqual(ids(await repo.listFiles()), ["b", "c", "a"]);
      assert.deepEqual((await repo.listFiles()).find((f) => f.id === "a"), a);
      assert.deepEqual((await repo.listFiles()).find((f) => f.id === "c"), c);
    },
  },
  {
    name: "putFiles replaces a file with the same id (save, rename, draft)",
    async run(repo) {
      await repo.putFiles([wfile("a"), wfile("b")]);
      await repo.putFiles([wfile("a", { name: "renamed.lua", content: "new", draft: "newer", updatedAt: 200 })]);
      const list = await repo.listFiles();
      assert.equal(list.length, 2);
      assert.deepEqual(list.find((f) => f.id === "a"), wfile("a", { name: "renamed.lua", content: "new", draft: "newer", updatedAt: 200 }));
    },
  },
  {
    name: "deleteFile removes only that file, and deleting a missing file is harmless",
    async run(repo) {
      await repo.putFiles([wfile("a"), wfile("b")]);
      await repo.deleteFile("a");
      await repo.deleteFile("never-existed");
      assert.deepEqual(ids(await repo.listFiles()), ["b"]);
    },
  },
  {
    name: "meta values can be set, replaced and removed",
    async run(repo) {
      await repo.setMeta("tabs", '["a"]');
      assert.equal(await repo.getMeta("tabs"), '["a"]');
      await repo.setMeta("tabs", '["a","b"]');
      assert.equal(await repo.getMeta("tabs"), '["a","b"]');
      await repo.setMeta("tabs", null);
      assert.equal(await repo.getMeta("tabs"), null);
    },
  },
  {
    name: "stores a large file (400 KB) unchanged",
    async run(repo) {
      const big = "local x = 1 -- ünï\n".repeat(22_000);
      await repo.putFiles([wfile("big", { content: big })]);
      assert.equal((await repo.listFiles())[0]!.content, big);
    },
  },
  {
    name: "a batch with a value that cannot be stored writes nothing (atomic)",
    async run(repo) {
      await repo.putFiles([wfile("keep")]);
      const bad = { ...wfile("bad"), content: (() => 1) as unknown as string };
      await assert.rejects(() => repo.putFiles([wfile("new1"), bad, wfile("new2")]));
      assert.deepEqual(ids(await repo.listFiles()), ["keep"]);
    },
  },
  {
    name: "clearAll removes files and meta",
    async run(repo) {
      await repo.putFiles([wfile("a")]);
      await repo.setMeta("seeded", "1");
      await repo.clearAll();
      assert.deepEqual(await repo.listFiles(), []);
      assert.equal(await repo.getMeta("seeded"), null);
    },
  },
];
