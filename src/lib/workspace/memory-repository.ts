import type { WorkspaceFile, WorkspaceRepository } from "./types";

/** Workspace storage that lives only as long as the page (used when IndexedDB is unavailable, and in tests). */
export class MemoryWorkspaceRepository implements WorkspaceRepository {
  readonly kind = "memory" as const;
  private files = new Map<string, WorkspaceFile>();
  private meta = new Map<string, string>();

  async listFiles(): Promise<WorkspaceFile[]> {
    return [...this.files.values()].map((f) => ({ ...f })).sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name));
  }
  async putFiles(files: WorkspaceFile[]): Promise<void> {
    const copies = files.map((f) => structuredClone(f)); // like IndexedDB: store a copy; a bad value throws before anything is stored
    for (const f of copies) this.files.set(f.id, f);
  }
  async deleteFile(id: string): Promise<void> {
    this.files.delete(id);
  }
  async getMeta(key: string): Promise<string | null> {
    return this.meta.get(key) ?? null;
  }
  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) this.meta.delete(key);
    else this.meta.set(key, value);
  }
  async clearAll(): Promise<void> {
    this.files.clear();
    this.meta.clear();
  }
  close(): void {}
}
