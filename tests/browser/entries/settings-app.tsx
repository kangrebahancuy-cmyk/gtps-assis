import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { SidebarContent } from "@/components/layout/sidebar-content";
import { ChatProvider } from "@/features/chat/chat-provider";
import { ChatView } from "@/features/chat/chat-view";
import { SectionContent } from "@/features/settings/section-content";
import { WorkspaceProvider } from "@/features/workspace/workspace-provider";
import { WorkspaceView } from "@/features/workspace/workspace-view";
import { useThemeSync } from "@/hooks/use-theme-sync";
import { SETTINGS_SECTIONS } from "@/lib/constants";
import { usePreferences } from "@/store/preferences-store";
import type { SettingsSectionId } from "@/types";

type Page = SettingsSectionId | "view:chat" | "view:workspace";

/** The real settings panels, the real sidebar, theme applier, chat and workspace, without Next.js. */
function Shell() {
  useThemeSync();
  const { sidebarCollapsed } = usePreferences();
  const initial = (new URLSearchParams(location.search).get("page") as Page | null) ?? "providers";
  const [page, setPage] = useState<Page>(initial);
  useEffect(() => {
    const onPush = (event: Event) => {
      const href = String((event as CustomEvent).detail);
      if (href === "/workspace") setPage("view:workspace");
      else if (href.startsWith("/chat")) setPage("view:chat");
    };
    window.addEventListener("stub-push", onPush);
    return () => window.removeEventListener("stub-push", onPush);
  }, []);
  return (
    <div style={{ display: "flex", minHeight: "760px", width: "1200px" }}>
      <aside aria-label="Sidebar" data-testid="sidebar" data-collapsed={sidebarCollapsed ? "true" : "false"} style={{ width: sidebarCollapsed ? 56 : 260, borderRight: "1px solid #888", display: "flex", flexDirection: "column" }}>
        <SidebarContent collapsed={sidebarCollapsed} showCollapseToggle />
      </aside>
      <div style={{ flex: 1, minWidth: 0 }}>
        <nav aria-label="Pages" style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: 4 }}>
          {SETTINGS_SECTIONS.map((s) => (
            <button key={s.id} data-page={s.id} aria-current={page === s.id} onClick={() => setPage(s.id)}>{`Settings: ${s.label}`}</button>
          ))}
          <button data-open="chat" onClick={() => setPage("view:chat")}>Open chat</button>
          <button data-open="workspace" onClick={() => setPage("view:workspace")}>Open workspace</button>
        </nav>
        <main data-page-content={page} style={{ padding: 12 }}>
          {page === "view:chat" ? <ChatView mode="chat" /> : page === "view:workspace" ? <WorkspaceView engine="basic" /> : <SectionContent id={page} />}
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ChatProvider>
    <WorkspaceProvider>
      <Shell />
    </WorkspaceProvider>
  </ChatProvider>,
);
