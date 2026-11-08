"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { DocsSidebar } from "@/features/docs/docs-sidebar";
import { DocsViewer } from "@/features/docs/docs-viewer";
import { ScraperPanel } from "@/features/docs/scraper-panel";
import {
  PLACEHOLDER_DOC_CATEGORIES,
  PLACEHOLDER_DOC_PAGES,
} from "@/lib/constants";
import { scraperClient } from "@/services/scraper-client";
import type { DocCategory, DocPage } from "@/types";
import type { ScrapedDocumentSummary } from "@/types/scraper";

const UNCATEGORIZED = "Uncategorized";

function toDocData(documents: readonly ScrapedDocumentSummary[]): {
  pages: DocPage[];
  categories: DocCategory[];
} {
  const categories = new Map<string, DocCategory>();
  const pages = documents.map((doc): DocPage => {
    const label = doc.category ?? UNCATEGORIZED;
    const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    categories.set(id, { id, label });
    return {
      id: String(doc.id),
      categoryId: id,
      title: doc.title,
      summary: `${doc.codeExampleCount} code example(s)`,
      body: doc.cleanedContent,
      sourceUrl: doc.url,
    };
  });
  return { pages, categories: [...categories.values()] };
}

export function DocsView() {
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [scraped, setScraped] = useState<ScrapedDocumentSummary[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadDocuments = useCallback(async () => {
    try {
      setScraped(await scraperClient.getDocuments());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load documents.");
    }
  }, []);

  useEffect(() => {
    void loadDocuments();
    // Refresh periodically so pages appear while a crawl is running.
    const timer = window.setInterval(() => void loadDocuments(), 5000);
    return () => window.clearInterval(timer);
  }, [loadDocuments]);

  const { allPages, categories } = useMemo(() => {
    if (scraped.length > 0) {
      const data = toDocData(scraped);
      return { allPages: data.pages, categories: data.categories };
    }
    return {
      allPages: [...PLACEHOLDER_DOC_PAGES],
      categories: [...PLACEHOLDER_DOC_CATEGORIES],
    };
  }, [scraped]);

  const pages = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allPages.filter((page) => {
      if (categoryId && page.categoryId !== categoryId) return false;
      if (!q) return true;
      return (
        page.title.toLowerCase().includes(q) ||
        page.body.toLowerCase().includes(q)
      );
    });
  }, [allPages, query, categoryId]);

  const selectedPage =
    pages.find((page) => page.id === selectedPageId) ?? pages[0] ?? null;

  return (
    <div className="flex h-full flex-col">
      <ScraperPanel onDataChanged={() => void loadDocuments()} />
      {loadError && (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-red-500">
          {loadError}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Documentation sidebar"
          className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border md:max-h-none md:w-72 md:border-b-0 md:border-r"
        >
          <DocsSidebar
            categories={categories}
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
    </div>
  );
}
