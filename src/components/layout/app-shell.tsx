"use client";

import { Menu } from "lucide-react";
import type { ReactNode } from "react";

import { Logo } from "@/components/layout/logo";
import { SidebarContent } from "@/components/layout/sidebar-content";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useHydrated } from "@/hooks/use-hydrated";
import { useThemeSync } from "@/hooks/use-theme-sync";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/store/ui-store";

interface AppShellProps {
  children: ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  useThemeSync();
  const hydrated = useHydrated();

  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const mobileOpen = useUiStore((state) => state.mobileSidebarOpen);
  const setMobileOpen = useUiStore((state) => state.setMobileSidebarOpen);

  // Persisted state is only trusted after hydration to avoid a markup mismatch.
  const collapsed = hydrated && sidebarCollapsed;

  return (
    <div className="flex h-dvh overflow-hidden bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside
        aria-label="Sidebar"
        className={cn(
          "hidden shrink-0 border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:block",
          collapsed ? "w-16" : "w-64",
        )}
      >
        <SidebarContent collapsed={collapsed} showCollapseToggle />
      </aside>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent aria-describedby="mobile-nav-description">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription id="mobile-nav-description" className="sr-only">
            Main navigation for GTPS Assistant
          </SheetDescription>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-3 md:justify-end md:px-4">
          <div className="flex items-center gap-2 md:hidden">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setMobileOpen(true)}
              aria-label="Open navigation"
            >
              <Menu />
            </Button>
            <Logo />
          </div>
          <ThemeToggle />
        </header>

        <main id="main-content" className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
