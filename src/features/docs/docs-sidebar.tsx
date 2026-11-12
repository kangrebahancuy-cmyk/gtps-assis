"use client";

import { Search } from "lucide-react";
import type { ReactNode } from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { SEARCH_SCOPES, type SearchScope } from "@/types/docs";

export type SidebarTab = "pages" | "api" | "examples";

const TABS: ReadonlyArray<{ id: SidebarTab; label: string }> = [
  { id: "pages", label: "Pages" },
  { id: "api", label: "API" },
  { id: "examples", label: "Lua examples" },
];

export const SCOPE_LABEL: Record<SearchScope, string> = {
  all: "Everything",
  title: "Title",
  keyword: "Keyword (page text)",
  api: "API name",
  function: "Function",
  code: "Inside code examples",
};

interface DocsSidebarProps {
  query: string;
  onQueryChange: (query: string) => void;
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
  tab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  children: ReactNode;
}

/** Search box with scope selector, the navigation tabs, and the active panel as children. */
export function DocsSidebar({ query, onQueryChange, scope, onScopeChange, tab, onTabChange, children }: DocsSidebarProps) {
  const searching = query.trim() !== "";
  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="space-y-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search documentation"
            aria-label="Search documentation"
            className="pl-8"
          />
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Search in
          <select
            value={scope}
            onChange={(event) => onScopeChange(event.target.value as SearchScope)}
            aria-label="Search scope"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground"
          >
            {SEARCH_SCOPES.map((s) => (
              <option key={s} value={s}>{SCOPE_LABEL[s]}</option>
            ))}
          </select>
        </label>
      </div>

      {!searching && (
        <div role="tablist" aria-label="Documentation sections" className="flex gap-1 border-b border-border">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => onTabChange(id)}
              className={cn(
                "-mb-px border-b-2 border-transparent px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground",
                tab === id && "border-primary font-medium text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">{children}</div>
    </div>
  );
}
