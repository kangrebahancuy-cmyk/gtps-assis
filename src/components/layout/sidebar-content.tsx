"use client";

import {
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Logo } from "@/components/layout/logo";
import { NavIcon } from "@/components/layout/nav-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useFilteredSessions } from "@/hooks/use-filtered-sessions";
import { useHydrated } from "@/hooks/use-hydrated";
import { NAV_ITEMS } from "@/lib/constants";
import { isNavItemActive } from "@/lib/navigation";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/store/chat-store";
import { useUiStore } from "@/store/ui-store";

interface SidebarContentProps {
  /** Icon-only mode (desktop collapsed). Never true inside the mobile drawer. */
  collapsed?: boolean;
  /** Show the collapse/expand control (desktop only). */
  showCollapseToggle?: boolean;
  /** Called after any navigation action, e.g. to close the mobile drawer. */
  onNavigate?: () => void;
}

export function SidebarContent({
  collapsed = false,
  showCollapseToggle = false,
  onNavigate,
}: SidebarContentProps) {
  const pathname = usePathname();
  const router = useRouter();
  const hydrated = useHydrated();

  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const startNewChat = useChatStore((state) => state.startNewChat);
  const setActiveSession = useChatStore((state) => state.setActiveSession);
  const deleteSession = useChatStore((state) => state.deleteSession);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const searchQuery = useChatStore((state) => state.searchQuery);
  const setSearchQuery = useChatStore((state) => state.setSearchQuery);
  const sessions = useFilteredSessions();

  const onChatRoute = pathname === "/chat";

  function handleNewChat() {
    startNewChat();
    router.push("/chat");
    onNavigate?.();
  }

  function handleOpenSession(id: string) {
    setActiveSession(id);
    router.push("/chat");
    onNavigate?.();
  }

  function handleExpandAndSearch() {
    if (collapsed) toggleSidebar();
  }

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn(
          "flex h-14 shrink-0 items-center px-3",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        <Link
          href="/"
          onClick={onNavigate}
          className="rounded-md"
          aria-label="GTPS Assistant home"
        >
          <Logo collapsed={collapsed} />
        </Link>
        {showCollapseToggle && !collapsed && (
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
          >
            <PanelLeftClose />
          </Button>
        )}
      </div>

      <div className="space-y-2 px-3 pb-2">
        <Button
          variant="outline"
          className={cn("w-full", collapsed ? "px-0" : "justify-start")}
          onClick={handleNewChat}
          aria-label="New Chat"
          title="New Chat"
        >
          <Plus />
          {!collapsed && "New Chat"}
        </Button>

        {collapsed ? (
          <Button
            variant="ghost"
            className="w-full px-0"
            onClick={handleExpandAndSearch}
            aria-label="Search Chats"
            title="Search Chats"
          >
            <Search />
          </Button>
        ) : (
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              className="pl-8"
            />
          </div>
        )}
      </div>

      {/* Chat history */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-thin">
        {!collapsed && (
          <>
            <h2 className="px-2 pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Chat History
            </h2>
            {!hydrated ? null : sessions.length === 0 ? (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                {searchQuery.trim()
                  ? "No chats match your search."
                  : "No chats yet."}
              </p>
            ) : (
              <ul className="space-y-0.5">
                {sessions.map((session) => {
                  const active = onChatRoute && session.id === activeSessionId;
                  return (
                    <li key={session.id} className="group relative">
                      <button
                        type="button"
                        onClick={() => handleOpenSession(session.id)}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 pr-8 text-left text-sm transition-colors hover:bg-accent",
                          active && "bg-accent text-accent-foreground",
                        )}
                      >
                        <MessageSquare
                          className="size-4 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="truncate">{session.title}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => deleteSession(session.id)}
                        aria-label={`Delete chat ${session.title}`}
                        className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>

      {/* Primary navigation */}
      <nav
        aria-label="Primary"
        className="shrink-0 space-y-0.5 border-t border-sidebar-border p-3"
      >
        {NAV_ITEMS.map((item) => {
          const active = isNavItemActive(item, pathname);
          return (
            <Link
              key={item.id}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              title={collapsed ? item.label : undefined}
              aria-label={collapsed ? item.label : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                collapsed && "justify-center px-0",
                active && "bg-accent font-medium text-accent-foreground",
              )}
            >
              {active && (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                />
              )}
              <NavIcon name={item.icon} className="size-4 shrink-0" />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </Link>
          );
        })}

        {showCollapseToggle && collapsed && (
          <Button
            variant="ghost"
            className="mt-1 w-full px-0"
            onClick={toggleSidebar}
            aria-label="Expand sidebar"
            title="Expand sidebar"
          >
            <PanelLeftOpen />
          </Button>
        )}
      </nav>
    </div>
  );
}
