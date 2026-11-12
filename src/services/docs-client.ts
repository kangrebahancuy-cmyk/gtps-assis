import { request } from "@/services/sync-client";
import type {
  ApiIndexEntry,
  DocTree,
  DocsStatus,
  DocumentDetail,
  ExampleIndexEntry,
  SearchResponse,
  SearchScope,
} from "@/types/docs";

/** Read-only client for the /api/docs/* routes. Everything it returns comes from the indexed database. */
export const docsClient = {
  tree: () => request<DocTree>("/api/docs/tree"),
  document: (id: number) => request<DocumentDetail>(`/api/docs/document?id=${id}`),
  search: (query: string, scope: SearchScope, signal?: AbortSignal) =>
    request<SearchResponse>(`/api/docs/search?q=${encodeURIComponent(query)}&scope=${scope}`, { signal }),
  api: async () => (await request<{ entries: ApiIndexEntry[] }>("/api/docs/api")).entries,
  luaExamples: async () =>
    (await request<{ examples: ExampleIndexEntry[] }>("/api/docs/examples?language=lua")).examples,
  status: () => request<DocsStatus>("/api/docs/status"),
};
