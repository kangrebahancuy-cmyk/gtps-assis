import type { WorkspaceFile, WorkspaceRepository } from "./types";

export const WORKSPACE_DB_NAME = "gtps-assistant-workspace";
const DB_VERSION = 1;
const FILES = "files";
const META = "meta";

const request = <T,>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });

const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });

/**
 * Workspace files in IndexedDB (database "gtps-assistant-workspace"):
 *   files  key: id, index name
 *   meta   key: key   (open tabs, active file, AI model choice, "starter file created")
 */
export class IndexedDbWorkspaceRepository implements WorkspaceRepository {
  readonly kind = "indexeddb" as const;

  private constructor(private db: IDBDatabase) {
    db.onversionchange = () => db.close();
  }

  static open(factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB, name = WORKSPACE_DB_NAME): Promise<IndexedDbWorkspaceRepository> {
    if (!factory) return Promise.reject(new Error("IndexedDB is not available in this browser."));
    return new Promise((resolve, reject) => {
      let opening: IDBOpenDBRequest;
      try {
        opening = factory.open(name, DB_VERSION);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("IndexedDB could not be opened."));
        return;
      }
      opening.onupgradeneeded = () => {
        const db = opening.result;
        db.createObjectStore(FILES, { keyPath: "id" }).createIndex("name", "name");
        db.createObjectStore(META, { keyPath: "key" });
      };
      opening.onsuccess = () => resolve(new IndexedDbWorkspaceRepository(opening.result));
      opening.onerror = () => reject(opening.error ?? new Error("IndexedDB could not be opened."));
      opening.onblocked = () => reject(new Error("IndexedDB is blocked by another tab using an older version."));
    });
  }

  async listFiles(): Promise<WorkspaceFile[]> {
    const tx = this.db.transaction(FILES, "readonly");
    const all = await request(tx.objectStore(FILES).getAll() as IDBRequest<WorkspaceFile[]>);
    return all.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }

  async putFiles(files: WorkspaceFile[]): Promise<void> {
    if (files.length === 0) return;
    const tx = this.db.transaction(FILES, "readwrite");
    const finished = done(tx);
    try {
      const store = tx.objectStore(FILES);
      for (const f of files) store.put(f);
    } catch (error) {
      finished.catch(() => {});
      try {
        tx.abort(); // no partial write
      } catch {
        // already finished
      }
      throw error;
    }
    await finished;
  }

  async deleteFile(id: string): Promise<void> {
    const tx = this.db.transaction(FILES, "readwrite");
    const finished = done(tx);
    tx.objectStore(FILES).delete(id);
    await finished;
  }

  async getMeta(key: string): Promise<string | null> {
    const tx = this.db.transaction(META, "readonly");
    const row = (await request(tx.objectStore(META).get(key))) as { key: string; value: string } | undefined;
    return row?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    const tx = this.db.transaction(META, "readwrite");
    const finished = done(tx);
    if (value === null) tx.objectStore(META).delete(key);
    else tx.objectStore(META).put({ key, value });
    await finished;
  }

  async clearAll(): Promise<void> {
    const tx = this.db.transaction([FILES, META], "readwrite");
    const finished = done(tx);
    tx.objectStore(FILES).clear();
    tx.objectStore(META).clear();
    await finished;
  }

  close(): void {
    this.db.close();
  }
}

/** IndexedDB when it works, otherwise memory plus the reason (the UI then warns that files will not survive a reload). */
export async function openWorkspaceRepository(): Promise<{ repository: WorkspaceRepository; fallbackReason: string | null }> {
  try {
    return { repository: await IndexedDbWorkspaceRepository.open(), fallbackReason: null };
  } catch (error) {
    const { MemoryWorkspaceRepository } = await import("./memory-repository");
    return { repository: new MemoryWorkspaceRepository(), fallbackReason: error instanceof Error ? error.message : "IndexedDB is unavailable." };
  }
}

/** Deletes the workspace database (used by "Clear local data"). Resolves when done, or after a short wait if another tab keeps it open. */
export function deleteWorkspaceDatabase(factory: IDBFactory | null = typeof indexedDB === "undefined" ? null : indexedDB, name = WORKSPACE_DB_NAME): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const finish = () => {
      clearTimeout(timer);
      resolve();
    };
    try {
      const req = factory.deleteDatabase(name);
      req.onsuccess = finish;
      req.onerror = finish;
      req.onblocked = () => {}; // our own connection closes itself on versionchange
    } catch {
      finish();
    }
  });
}
