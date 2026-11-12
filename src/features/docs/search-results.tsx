import { ExternalLink } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Snippet } from "@/features/docs/snippet";
import type { SearchResponse, SearchResult } from "@/types/docs";

function typeLabel(result: SearchResult): string {
  if (result.type === "api") return result.kind ?? "api";
  if (result.type === "code") return result.label ? `${result.label} code` : "code";
  return "page";
}

interface SearchResultsProps {
  response: SearchResponse | null;
  loading: boolean;
  error: string | null;
  onSelect: (documentId: number) => void;
}

/** Matching documents, API entries and code, each with title, matching text, category and original URL. */
export function SearchResults({ response, loading, error, onSelect }: SearchResultsProps) {
  if (error) return <p role="alert" className="text-sm text-red-500">{error}</p>;
  if (!response) return <p className="text-sm text-muted-foreground">Searching…</p>;

  const { results, counts } = response;
  return (
    <div aria-busy={loading}>
      <p className="mb-2 text-xs text-muted-foreground" role="status">
        {results.length === 0
          ? `No results for “${response.query}”.`
          : `${results.length} result${results.length === 1 ? "" : "s"}: ${counts.document} page, ${counts.api} API, ${counts.code} code`}
      </p>
      <ul className="space-y-2">
        {results.map((result, index) => (
          <li key={`${result.type}-${result.documentId}-${result.label ?? ""}-${index}`} className="rounded-lg border border-border p-2.5">
            <div className="flex items-start gap-2">
              <button type="button" onClick={() => onSelect(result.documentId)} className="min-w-0 flex-1 text-left">
                <span className="block break-words text-sm font-medium hover:underline">
                  {result.type === "api" && result.label ? result.label : result.documentTitle}
                </span>
                {result.type !== "document" && (
                  <span className="block truncate text-xs text-muted-foreground">in {result.documentTitle}</span>
                )}
              </button>
              <Badge variant="muted" className="shrink-0">{typeLabel(result)}</Badge>
            </div>
            <p className={result.type === "code" ? "mt-1 break-all font-mono text-xs text-muted-foreground" : "mt-1 text-xs text-muted-foreground"}>
              <Snippet segments={result.snippet} />
            </p>
            <p className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              {result.category && <span>{result.category}</span>}
              <a
                href={result.documentUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex min-w-0 items-center gap-1 underline underline-offset-2 hover:text-foreground"
              >
                <span className="truncate">{result.documentUrl}</span>
                <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
              </a>
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
