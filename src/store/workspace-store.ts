import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { INITIAL_LUA_FILES } from "@/lib/constants";
import { STORAGE_KEYS, safeStorage } from "@/services/storage";
import type { LuaFile } from "@/types";

interface WorkspaceState {
  files: LuaFile[];
  activeFileId: string;
  setActiveFile: (id: string) => void;
  updateFileContent: (id: string, content: string) => void;
}

const initialFiles: LuaFile[] = INITIAL_LUA_FILES.map((file) => ({ ...file }));

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      files: initialFiles,
      activeFileId: initialFiles[0]?.id ?? "",
      setActiveFile: (id) => set({ activeFileId: id }),
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
