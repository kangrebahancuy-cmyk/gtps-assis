import type { FailedPage } from "@/types/scraper";
import type { CurrentRun, SyncRunRecord, SyncState } from "@/types/sync";

/** Everything here is read from the indexed SQLite database. */

export type ApiKind = "function" | "method" | "callback" | "event";

export interface DocTreeNode {
  id: string;
  kind: "category" | "folder" | "page";
  label: string;
  /** Set for pages, and for folders whose own URL is an indexed page. */
  documentId: number | null;
  url: string | null;
  /** Indexed pages in this subtree (including the node's own page). */
  pageCount: number;
  /** "navigation": group read from the site's sidebar. "url-path": derived from the page URL. */
  origin: "navigation" | "url-path";
  children: DocTreeNode[];
}

export interface DocTree {
  roots: DocTreeNode[];
  totalPages: number;
  categories: number;
}

export interface DocCodeExample {
  id: number;
  language: string | null;
  context: string | null;
  code: string;
}

export interface DocApiEntry {
  id: number;
  name: string;
  kind: ApiKind;
  /** Part before ":" or "." (e.g. "Player"), null for global functions and callbacks. */
  owner: string | null;
  signature: string;
  params: string[];
  returns: string | null;
  description: string | null;
}

export interface DocumentDetail {
  id: number;
  title: string;
  /** Original documentation URL. */
  url: string;
  category: string | null;
  categoryPath: string[];
  markdown: string;
  createdAt: string;
  updatedAt: string;
  /** When the page was last fetched and checked against the site. */
  lastScrapedAt: string;
  codeExamples: DocCodeExample[];
  apiEntries: DocApiEntry[];
}

export interface DocumentRef {
  documentId: number;
  documentTitle: string;
  documentUrl: string;
  category: string | null;
}

export interface ApiIndexEntry extends DocApiEntry, DocumentRef {}

export interface ExampleIndexEntry extends DocCodeExample, DocumentRef {}

export type SearchScope = "all" | "title" | "keyword" | "api" | "function" | "code";
export const SEARCH_SCOPES: readonly SearchScope[] = ["all", "title", "keyword", "api", "function", "code"];

export interface SnippetSegment {
  text: string;
  match: boolean;
}

export interface SearchResult extends DocumentRef {
  type: "document" | "api" | "code";
  /** API name for api hits, code language for code hits. */
  label: string | null;
  kind: ApiKind | null;
  snippet: SnippetSegment[];
}

export interface SearchResponse {
  query: string;
  scope: SearchScope;
  results: SearchResult[];
  counts: { document: number; api: number; code: number };
}

export interface DocsStatus {
  totals: {
    documents: number;
    codeExamples: number;
    luaExamples: number;
    apiEntries: number;
    categories: number;
    /** Documents present in the full-text index; equals `documents` when search is complete. */
    searchIndexed: number;
  };
  apiByKind: Record<ApiKind, number>;
  lastSuccessAt: string | null;
  lastRun: SyncRunRecord | null;
  /** URLs whose latest crawl attempt failed. */
  failedPages: FailedPage[];
  /** Documents the site no longer serves (kept locally, hidden from the explorer). */
  removedDocuments: number;
  /** Live engine state of this backend process. */
  sync: { state: SyncState; current: CurrentRun | null };
}
