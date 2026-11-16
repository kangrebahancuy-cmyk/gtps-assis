import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { ChatProvider, useChat } from "@/features/chat/chat-provider";
import { ChatView } from "@/features/chat/chat-view";
import { HistoryList } from "@/features/chat/history-list";
import { AiSettingsPanel } from "@/features/settings/ai/ai-settings-panel";
import { ChatHistoryPanel } from "@/features/settings/chat-history-panel";
import { GENERATOR_PROMPTS } from "@/lib/constants";
import { modeOf, type ChatMode } from "@/lib/chat/mode";
import { useWorkspaceStore } from "@/store/workspace-store";

/** The workspace page of the real app is an editor; the harness only lists the files so tests can see what was added. */
function WorkspaceStub() {
  const files = useWorkspaceStore((s) => s.files);
  const active = useWorkspaceStore((s) => s.activeFileId);
  return (
    <section aria-label="Workspace files">
      <h1>Lua Workspace</h1>
      {files.map((f) => (
        <article key={f.id} data-testid="workspace-file" data-name={f.name} data-active={f.id === active}>
          <h2>{f.name}</h2>
          <pre>{f.content}</pre>
        </article>
      ))}
    </section>
  );
}

/** A bare-bones shell around the real chat components (no Next.js): sidebar with history, chat and generator pages, settings pages. */
function Shell() {
  const { chat } = useChat();
  const [page, setPage] = useState<"chat" | "history" | "providers" | "workspace">("chat");
  const [mode, setMode] = useState<ChatMode>("chat");
  useEffect(() => {
    const onPush = (event: Event) => {
      const href = String((event as CustomEvent).detail);
      if (href === "/workspace") setPage("workspace");
      else if (href === "/generator") { setMode("generate"); setPage("chat"); }
      else if (href === "/chat") { setMode("chat"); setPage("chat"); }
    };
    window.addEventListener("stub-push", onPush);
    return () => window.removeEventListener("stub-push", onPush);
  }, []);
  return (
    <div style={{ display: "flex", height: "700px", width: "1000px" }}>
      <aside style={{ width: 260, display: "flex", flexDirection: "column", borderRight: "1px solid #888" }} aria-label="Sidebar">
        <button onClick={() => { void chat?.newChat(mode); setPage("chat"); }}>New Chat</button>
        <HistoryList onOpenChat={(conversation) => { setMode(modeOf(conversation)); setPage("chat"); }} />
        <nav>
          <button onClick={() => { setMode("chat"); setPage("chat"); }}>Go to chat</button>
          <button onClick={() => { setMode("generate"); setPage("chat"); }}>Go to generator</button>
          <button onClick={() => setPage("workspace")}>Go to workspace</button>
          <button onClick={() => setPage("history")}>Go to chat settings</button>
          <button onClick={() => setPage("providers")}>Go to provider settings</button>
        </nav>
      </aside>
      <main style={{ flex: 1, minWidth: 0 }}>
        {page === "chat" ? <ChatView mode={mode} /> : page === "history" ? <ChatHistoryPanel /> : page === "workspace" ? <WorkspaceStub /> : <AiSettingsPanel section="providers" />}
      </main>
    </div>
  );
}

(window as unknown as { __generatorPromptCount: number }).__generatorPromptCount = GENERATOR_PROMPTS.length;

createRoot(document.getElementById("root")!).render(
  <ChatProvider>
    <Shell />
  </ChatProvider>,
);
