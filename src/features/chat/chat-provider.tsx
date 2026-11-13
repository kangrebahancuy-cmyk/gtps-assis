"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import { ChatController, LOADING_STATE, type ChatState } from "@/lib/chat/controller";
import { openChatRepository } from "@/lib/chat/idb-repository";
import { aiClient } from "@/services/ai-client";

const ChatContext = createContext<ChatController | null>(null);

const noSubscription = () => () => {};
const loading = () => LOADING_STATE;

/**
 * Creates the chat engine once in the browser (IndexedDB, or memory if it is
 * unavailable) and shares it with the sidebar, the chat page and the settings.
 * Pass `controller` to supply your own (tests).
 */
export function ChatProvider({ children, controller }: { children: ReactNode; controller?: ChatController }) {
  const [chat, setChat] = useState<ChatController | null>(controller ?? null);

  useEffect(() => {
    if (controller) {
      setChat(controller);
      void controller.init();
      return;
    }
    let cancelled = false;
    let created: ChatController | null = null;
    void openChatRepository().then(({ repository, fallbackReason }) => {
      if (cancelled) {
        repository.close();
        return;
      }
      created = new ChatController({ repository, ai: aiClient, fallbackReason });
      setChat(created);
      void created.init();
    });
    return () => {
      cancelled = true;
      created?.dispose();
    };
  }, [controller]);

  return <ChatContext.Provider value={chat}>{children}</ChatContext.Provider>;
}

/** Current chat state, and the engine to call (null until the browser has opened the history). */
export function useChat(): { state: ChatState; chat: ChatController | null } {
  const chat = useContext(ChatContext);
  const state = useSyncExternalStore(chat ? chat.subscribe : noSubscription, chat ? chat.getState : loading, loading);
  return { state, chat };
}
