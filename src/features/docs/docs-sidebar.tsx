"use client";

import { Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { DocCategory, DocPage } from "@/types";

interface DocsSidebarProps {
  categories: readonly DocCategory[];
  pages: readonly DocPage[];
  query: string;
  onQueryChange: (query: string) => void;
  categoryId: string | null;
  onCategoryChange: (id: string | null) => void;
  selectedPageId: string | null;
  onSelectPage: (id: string) => void;
}

export function DocsSidebar({
  categories,
  pages,
  query,
  onQueryChange,
  categoryId,
  onCategoryChange,
  selectedPageId,
  onSelectPage,
}: DocsSidebarProps) {
  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search documentation"
          aria-label="Search documentation"
          className="pl-8"
        />
      </div>

      <nav aria-label="Documentation categories">
        <h2 className="pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Categories
        </h2>
        <ul className="space-y-0.5">
          {[{ id: null, label: "All" }, ...categories].map((category) => {
            const active = category.id === categoryId;
            return (
              <li key={category.id ?? "all"}>
                <button
                  type="button"
                  onClick={() => onCategoryChange(category.id)}
                  aria-pressed={active}
                  className={cn(
                    "w-full rounded-md px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                    active && "bg-accent font-medium text-accent-foreground",
                  )}
                >
                  {category.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <nav aria-label="Documentation pages" className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        <h2 className="pb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Pages
        </h2>
        {pages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No pages match.</p>
        ) : (
          <ul className="space-y-0.5">
            {pages.map((page) => {
              const active = page.id === selectedPageId;
              return (
                <li key={page.id}>
                  <button
                    type="button"
                    onClick={() => onSelectPage(page.id)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "w-full rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent",
                      active && "bg-accent font-medium",
                    )}
                  >
                    {page.title}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
