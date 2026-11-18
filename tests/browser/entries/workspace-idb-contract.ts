import { deleteWorkspaceDatabase, IndexedDbWorkspaceRepository } from "@/lib/workspace/idb-repository";
import { workspaceContract, wfile } from "../../support/workspace-repo-contract";

const w = window as unknown as Record<string, unknown>;
const deleteDb = (name: string) =>
  new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });

/** Runs one shared contract case against a brand-new database. */
w.runCase = async (index: number): Promise<{ ok: boolean; error?: string }> => {
  const name = `ws-contract-${index}`;
  await deleteDb(name);
  const repo = await IndexedDbWorkspaceRepository.open(indexedDB, name);
  try {
    await workspaceContract[index]!.run(repo);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    repo.close();
  }
};

const DB = "ws-persist-test";
w.writeData = async () => {
  const repo = await IndexedDbWorkspaceRepository.open(indexedDB, DB);
  await repo.putFiles([wfile("keep", { name: "Zażółć.lua", content: "héllo 🙂\n", draft: "unsaved ✓" })]);
  await repo.setMeta("tabs", '["keep"]');
  repo.close();
};
w.readData = async () => {
  const repo = await IndexedDbWorkspaceRepository.open(indexedDB, DB);
  const out = { files: await repo.listFiles(), tabs: await repo.getMeta("tabs") };
  repo.close();
  return out;
};
w.wipe = () => deleteDb(DB);
w.unavailable = async () => {
  try {
    await IndexedDbWorkspaceRepository.open(null);
    return "opened";
  } catch (e) {
    return (e as Error).message;
  }
};

/** "Clear local data": the database is deleted even while a connection is open, and reopens empty. */
w.clearWhileOpen = async () => {
  await deleteDb("ws-clear");
  const open = await IndexedDbWorkspaceRepository.open(indexedDB, "ws-clear");
  await open.putFiles([wfile("a")]);
  await open.setMeta("seeded", "1");
  await deleteWorkspaceDatabase(indexedDB, "ws-clear");
  const again = await IndexedDbWorkspaceRepository.open(indexedDB, "ws-clear");
  const out = { files: (await again.listFiles()).length, seeded: await again.getMeta("seeded") };
  again.close();
  return out;
};
