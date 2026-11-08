"use client";

import { useMemo, useState } from "react";

import { DocsSidebar } from "@/features/docs/docs-sidebar";
import { DocsViewer } from "@/features/docs/docs-viewer";
import {
  PLACEHOLDER_DOC_CATEGORIES,
  PLACEHOLDER_DOC_PAGES,
} from "@/lib/constants";

export function DocsView() {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(
    PLACEHOLDER_DOC_PAGES[0]?.id ?? null,
  );

  const pages = useMemo(() => {
    const q = query.trim().toLowerCase();
    return PLACEHOLDER_DOC_PAGES.filter((page) => {
      if (categoryId && page.categoryId !== categoryId) return false;
      if (!q) return true;
      return (
        page.title.toLowerCase().includes(q) ||
        page.body.toLowerCase().includes(q)
      );
    });
  }, [query, categoryId]);

  const selectedPage =
    pages.find((page) => page.id === selectedPageId) ?? null;

  return (
    <div className="flex h-full flex-col md:flex-row">
      <aside
        aria-label="Documentation sidebar"
        className="max-h-[50%] shrink-0 overflow-y-auto border-b border-border md:max-h-none md:w-72 md:border-b-0 md:border-r"
      >
        <DocsSidebar
          categories={PLACEHOLDER_DOC_CATEGORIES}
          pages={pages}
          query={query}
          onQueryChange={setQuery}
          categoryId={categoryId}
          onCategoryChange={setCategoryId}
          selectedPageId={selectedPage?.id ?? null}
          onSelectPage={setSelectedPageId}
        />
      </aside>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-thin">
        <DocsViewer page={selectedPage} />
      </div>
    </div>
  );
}
