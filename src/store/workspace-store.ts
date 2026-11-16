import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { INITIAL_LUA_FILES } from "@/lib/constants";
import { uniqueFileName } from "@/lib/workspace-files";
import { STORAGE_KEYS, safeStorage } from "@/services/storage";
import type { LuaFile } from "@/types";

interface WorkspaceState {
  files: LuaFile[];
  activeFileId: string;
  setActiveFile: (id: string) => void;
  updateFileContent: (id: string, content: string) => void;
  /** Adds a file (the name is made safe and unique), makes it the active one and returns its name. */
  addFile: (name: string, content: string) => string;
}

const initialFiles: LuaFile[] = INITIAL_LUA_FILES.map((file) => ({ ...file }));

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set, get) => ({
      files: initialFiles,
      activeFileId: initialFiles[0]?.id ?? "",
      setActiveFile: (id) => set({ activeFileId: id }),
      addFile: (name, content) => {
        const unique = uniqueFileName(get().files.map((f) => f.name), name);
        const file: LuaFile = { id: `file_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, name: unique, content };
        set((state) => ({ files: [...state.files, file], activeFileId: file.id }));
        return unique;
      },
      updateFileContent: (id, content) =>
        set((state) => ({
          files: state.files.map((file) =>
            file.id === id ? { ...file, content } : file,
          ),
        })),
    }),
    {
      name: STORAGE_KEYS.workspace,
      storage: createJSONStorage(() => safeStorage),
    },
  ),
);
