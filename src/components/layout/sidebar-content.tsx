"use client";

import { PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { Logo } from "@/components/layout/logo";
import { NavIcon } from "@/components/layout/nav-icon";
import { Button } from "@/components/ui/button";
import { useChat } from "@/features/chat/chat-provider";
import { HistoryList } from "@/features/chat/history-list";
import { NAV_ITEMS } from "@/lib/constants";
import { isNavItemActive } from "@/lib/navigation";
import { cn } from "@/lib/utils";
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
  const { chat } = useChat();

  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  function goToChat() {
    router.push("/chat");
    onNavigate?.();
  }

  function handleNewChat() {
    void chat?.newChat();
    goToChat();
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
        ) : null}
      </div>

      {/* Chat history */}
      {collapsed ? <div className="min-h-0 flex-1" /> : <HistoryList onOpenChat={goToChat} />}

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
