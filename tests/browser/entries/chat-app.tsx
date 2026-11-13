import { useState } from "react";
import { createRoot } from "react-dom/client";

import { ChatProvider, useChat } from "@/features/chat/chat-provider";
import { ChatView } from "@/features/chat/chat-view";
import { HistoryList } from "@/features/chat/history-list";
import { ChatHistoryPanel } from "@/features/settings/chat-history-panel";
import { AiSettingsPanel } from "@/features/settings/ai/ai-settings-panel";

/** A bare-bones shell around the real chat components (no Next.js): sidebar with history, chat page, settings pages. */
function Shell() {
  const { chat } = useChat();
  const [page, setPage] = useState<"chat" | "history" | "providers">("chat");
  return (
    <div style={{ display: "flex", height: "700px", width: "1000px" }}>
      <aside style={{ width: 260, display: "flex", flexDirection: "column", borderRight: "1px solid #888" }} aria-label="Sidebar">
        <button onClick={() => { void chat?.newChat(); setPage("chat"); }}>New Chat</button>
        <HistoryList onOpenChat={() => setPage("chat")} />
        <nav>
          <button onClick={() => setPage("chat")}>Go to chat</button>
          <button onClick={() => setPage("history")}>Go to chat settings</button>
          <button onClick={() => setPage("providers")}>Go to provider settings</button>
        </nav>
      </aside>
      <main style={{ flex: 1, minWidth: 0 }}>
        {page === "chat" ? <ChatView /> : page === "history" ? <ChatHistoryPanel /> : <AiSettingsPanel section="providers" />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChatProvider>
    <Shell />
  </ChatProvider>,
);
