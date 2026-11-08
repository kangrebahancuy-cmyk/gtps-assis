import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createId } from "@/lib/utils";
import { STORAGE_KEYS, safeStorage } from "@/services/storage";
import type { ChatSession } from "@/types";

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  searchQuery: string;
  /** Unsent text in the composer. Not persisted. */
  composerDraft: string;
  setComposerDraft: (draft: string) => void;
  /** Starts a new chat, reusing the active one if it is still empty. */
  startNewChat: () => string;
  setActiveSession: (id: string) => void;
  deleteSession: (id: string) => void;
  setSearchQuery: (query: string) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeSessionId: null,
      searchQuery: "",
      composerDraft: "",
      setComposerDraft: (draft) => set({ composerDraft: draft }),

      startNewChat: () => {
        const { sessions, activeSessionId } = get();
        const active = sessions.find((s) => s.id === activeSessionId);
        if (active && active.messages.length === 0) return active.id;

        const now = Date.now();
        const session: ChatSession = {
          id: createId("chat"),
          title: "New chat",
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        set({ sessions: [session, ...sessions], activeSessionId: session.id });
        return session.id;
      },

      setActiveSession: (id) => set({ activeSessionId: id }),

      deleteSession: (id) =>
        set((state) => ({
          sessions: state.sessions.filter((s) => s.id !== id),
          activeSessionId:
            state.activeSessionId === id ? null : state.activeSessionId,
        })),

      setSearchQuery: (query) => set({ searchQuery: query }),
    }),
    {
      name: STORAGE_KEYS.chat,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
      }),
    },
  ),
);
