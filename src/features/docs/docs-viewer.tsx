"use client";

import { ExternalLink, FileText } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { MarkdownRenderer } from "@/features/chat/markdown-renderer";
import { comparableUrl } from "@/lib/doc-tree";
import { formatDateTime } from "@/lib/format";
import { parseMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { docsClient } from "@/services/docs-client";
import { BackendUnreachableError } from "@/services/sync-client";
import type { DocumentDetail } from "@/types/docs";

interface DocsViewerProps {
  documentId: number | null;
  /** Original URL -> id, used to open links to other indexed pages inside the explorer. */
  urlToId: ReadonlyMap<string, number>;
  onNavigate: (documentId: number) => void;
}

type LoadState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; document: DocumentDetail };

interface DocumentViewProps {
  document: DocumentDetail;
  urlToId: ReadonlyMap<string, number>;
  onNavigate: (documentId: number) => void;
}

/** One document: category path, original link, last synchronization date and the rendered Markdown. */
export function DocumentView({ document: doc, urlToId, onNavigate }: DocumentViewProps) {
  const articleRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    articleRef.current?.parentElement?.scrollTo?.({ top: 0 });
  }, [doc.id]);

  const outline = useMemo(
    () => parseMarkdown(doc.markdown).flatMap((b) => (b.type === "heading" && b.level >= 2 && b.level <= 3 ? [b] : [])),
    [doc.markdown],
  );

  function handleLinkClick(href: string, event: MouseEvent<HTMLAnchorElement>) {
    const target = urlToId.get(comparableUrl(href));
    if (target === undefined) return; // external or not indexed: the browser opens it in a new tab
    event.preventDefault();
    onNavigate(target);
  }

  return (
    <article ref={articleRef} className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8" aria-label={doc.title}>
      <header className="mb-4 border-b border-border pb-4">
        {doc.categoryPath.length > 0 && (
          <nav aria-label="Category" className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            {doc.categoryPath.map((name, index) => (
              <span key={`${name}-${index}`}>
                {index > 0 && <span aria-hidden="true"> / </span>}
                {name}
              </span>
            ))}
          </nav>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={doc.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
          >
            <ExternalLink />
            Open original page
          </a>
          <Badge variant="muted">{doc.codeExamples.length} code example{doc.codeExamples.length === 1 ? "" : "s"}</Badge>
          {doc.apiEntries.length > 0 && <Badge variant="muted">{doc.apiEntries.length} API entr{doc.apiEntries.length === 1 ? "y" : "ies"}</Badge>}
        </div>
        <p className="mt-2 break-all text-xs text-muted-foreground">
          Source:{" "}
          <a href={doc.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 hover:text-foreground">
            {doc.url}
          </a>
        </p>
        <p className="text-xs text-muted-foreground">
          Last synchronized: <time dateTime={doc.lastScrapedAt}>{formatDateTime(doc.lastScrapedAt)}</time>
          {doc.updatedAt !== doc.lastScrapedAt && <> · content last changed: {formatDateTime(doc.updatedAt)}</>}
        </p>
      </header>

      {outline.length >= 3 && (
        <nav aria-label="On this page" className="mb-4 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
          <p className="mb-1 font-medium text-muted-foreground">On this page</p>
          <ul className="space-y-0.5">
            {outline.map((h) => (
              <li key={h.id} style={{ paddingLeft: `${(h.level - 2) * 12}px` }}>
                <a href={`#${h.id}`} className="hover:underline">{h.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {doc.markdown.trim() ? (
        <MarkdownRenderer source={doc.markdown} onLinkClick={handleLinkClick} />
      ) : (
        <p className="text-sm text-muted-foreground">This page has no text content.</p>
      )}
    </article>
  );
}

export function DocsViewer({ documentId, urlToId, onNavigate }: DocsViewerProps) {
  const [state, setState] = useState<LoadState>({ phase: "idle" });

  useEffect(() => {
    if (documentId === null) {
      setState({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setState({ phase: "loading" });
    docsClient
      .document(documentId)
      .then((document) => {
        if (!cancelled) setState({ phase: "ready", document });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          phase: "error",
          message: e instanceof BackendUnreachableError ? "Cannot reach the local backend." : e instanceof Error ? e.message : "Could not load the document.",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (state.phase === "idle") {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <FileText className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-medium">No document selected</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose a page from the navigation, or search the documentation.</p>
      </div>
    );
  }
  if (state.phase === "loading") {
    return <p className="px-8 py-8 text-sm text-muted-foreground" role="status">Loading document…</p>;
  }
  if (state.phase === "error") {
    return <p role="alert" className="px-8 py-8 text-sm text-red-500">{state.message}</p>;
  }
  return <DocumentView document={state.document} urlToId={urlToId} onNavigate={onNavigate} />;
}
