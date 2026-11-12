"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiList } from "@/features/docs/api-list";
import { DocTree } from "@/features/docs/doc-tree";
import { DocsSidebar, type SidebarTab } from "@/features/docs/docs-sidebar";
import { DocsStatusBar } from "@/features/docs/docs-status-bar";
import { DocsViewer } from "@/features/docs/docs-viewer";
import { ExamplesList } from "@/features/docs/examples-list";
import { SearchResults } from "@/features/docs/search-results";
import { SyncPanel } from "@/features/docs/sync-panel";
import { useDocsStatus } from "@/hooks/use-docs-status";
import { firstDocumentId, urlIndex } from "@/lib/doc-tree";
import { docsClient } from "@/services/docs-client";
import { BackendUnreachableError } from "@/services/sync-client";
import type { ApiIndexEntry, DocTree as DocTreeData, ExampleIndexEntry, SearchResponse, SearchScope } from "@/types/docs";

const SEARCH_DEBOUNCE_MS = 250;

const messageOf = (e: unknown, fallback: string): string =>
  e instanceof BackendUnreachableError ? "Cannot reach the local backend." : e instanceof Error ? e.message : fallback;

/** Remembers the open page in the address bar (?doc=ID) so it survives reloads and can be shared. */
function readDocParam(): number | null {
  const raw = new URLSearchParams(window.location.search).get("doc");
  const id = Number(raw);
  return raw !== null && Number.isInteger(id) && id > 0 ? id : null;
}

export function DocsView() {
  const statusData = useDocsStatus();
  const { status } = statusData;

  const [tree, setTree] = useState<DocTreeData | null>(null);
  const [apiEntries, setApiEntries] = useState<ApiIndexEntry[] | null>(null);
  const [examples, setExamples] = useState<ExampleIndexEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [tab, setTab] = useState<SidebarTab>("pages");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SearchScope>("all");
  const [search, setSearch] = useState<SearchResponse | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);

  // Reload the lists whenever the index may have changed (a run finished, documents were added or removed).
  const indexKey = status ? `${status.totals.documents}|${status.totals.apiEntries}|${status.lastSuccessAt ?? ""}|${status.lastRun?.finishedAt ?? ""}` : "";
  const reload = useCallback(async () => {
    try {
      const [nextTree, nextApi, nextExamples] = await Promise.all([docsClient.tree(), docsClient.api(), docsClient.luaExamples()]);
      setTree(nextTree);
      setApiEntries(nextApi);
      setExamples(nextExamples);
      setLoadError(null);
    } catch (e) {
      setLoadError(messageOf(e, "Could not load the documentation."));
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload, indexKey]);

  // Initial page: ?doc= if present, otherwise the first indexed page.
  useEffect(() => {
    if (selectedId !== null || !tree) return;
    setSelectedId(readDocParam() ?? firstDocumentId(tree.roots));
  }, [tree, selectedId]);

  const select = useCallback((id: number) => {
    setSelectedId(id);
    const url = new URL(window.location.href);
    url.searchParams.set("doc", String(id));
    window.history.replaceState(null, "", url);
  }, []);

  // Debounced, cancellable search.
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearch(null);
      setSearchError(null);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setSearching(true);
    const timer = window.setTimeout(() => {
      docsClient
        .search(q, scope, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setSearch(response);
          setSearchError(null);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) setSearchError(messageOf(e, "Search failed."));
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, scope]);

  const urlToId = useMemo(() => (tree ? urlIndex(tree.roots) : new Map<string, number>()), [tree]);

  const panel = query.trim() ? (
    <SearchResults response={search} loading={searching} error={searchError} onSelect={select} />
  ) : tab === "pages" ? (
    tree ? <DocTree roots={tree.roots} selectedId={selectedId} onSelect={select} /> : <p className="text-sm text-muted-foreground">Loading…</p>
  ) : tab === "api" ? (
    apiEntries ? <ApiList entries={apiEntries} onSelect={select} /> : <p className="text-sm text-muted-foreground">Loading…</p>
  ) : examples ? (
    <ExamplesList examples={examples} onSelect={select} />
  ) : (
    <p className="text-sm text-muted-foreground">Loading…</p>
  );

  return (
    <div className="flex h-full flex-col">
      <DocsStatusBar data={statusData} syncOpen={syncOpen} onToggleSync={() => setSyncOpen((open) => !open)} />
      {syncOpen && <SyncPanel onDocumentsChanged={() => void reload()} />}
      {loadError && (
        <p role="alert" className="border-b border-border px-4 py-2 text-sm text-red-500">
          {loadError}
        </p>
      )}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside
          aria-label="Documentation sidebar"
          className="max-h-[45%] shrink-0 overflow-hidden border-b border-border md:max-h-none md:w-80 md:border-b-0 md:border-r"
        >
          <DocsSidebar query={query} onQueryChange={setQuery} scope={scope} onScopeChange={setScope} tab={tab} onTabChange={setTab}>
            {panel}
          </DocsSidebar>
        </aside>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scrollbar-thin">
          <DocsViewer documentId={selectedId} urlToId={urlToId} onNavigate={select} />
        </div>
      </div>
    </div>
  );
}
