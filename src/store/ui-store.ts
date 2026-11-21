import { create } from "zustand";

/** Transient interface state only. Anything the user chose and expects to persist lives in preferences-store. */
interface UiState {
  mobileSidebarOpen: boolean;
  setMobileSidebarOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  mobileSidebarOpen: false,
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
}));
