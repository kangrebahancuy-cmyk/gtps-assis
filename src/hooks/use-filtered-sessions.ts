"use client";

import { useMemo } from "react";

import { useChatStore } from "@/store/chat-store";
import type { ChatSession } from "@/types";

/** Chat sessions filtered by the sidebar search query (title match). */
export function useFilteredSessions(): ChatSession[] {
  const sessions = useChatStore((state) => state.sessions);
  const query = useChatStore((state) => state.searchQuery);

  return useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);
}
