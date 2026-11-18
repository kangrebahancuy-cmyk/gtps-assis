/** A Lua file in the workspace. `content` is the last SAVED text; `draft` is an unsaved edit (null = no unsaved changes). */
export interface WorkspaceFile {
  id: string;
  name: string;
  content: string;
  draft: string | null;
  createdAt: number;
  /** Time of the last save (or creation). */
  updatedAt: number;
}

/** Text shown in the editor: the unsaved draft when there is one, otherwise the saved content. */
export const textOf = (file: Pick<WorkspaceFile, "content" | "draft">): string => file.draft ?? file.content;

/** True when the editor holds changes that are not saved. */
export const isDirty = (file: Pick<WorkspaceFile, "content" | "draft">): boolean => file.draft !== null && file.draft !== file.content;

/**
 * Where workspace files live. IndexedDB in the browser (database "gtps-assistant-workspace"),
 * memory when IndexedDB is unavailable. Both follow the same contract (tests/support/workspace-repo-contract.ts).
 */
export interface WorkspaceRepository {
  readonly kind: "indexeddb" | "memory";
  listFiles(): Promise<WorkspaceFile[]>;
  /** Inserts or replaces files in ONE atomic write. */
  putFiles(files: WorkspaceFile[]): Promise<void>;
  deleteFile(id: string): Promise<void>;
  /** Small values (open tabs, last active file, AI model choice ...). */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string | null): Promise<void>;
  clearAll(): Promise<void>;
  close(): void;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
