"use client";

import { BookOpen, ExternalLink, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { citedNumbers, docsHref } from "@/lib/chat/citations";
import type { StoredMessage } from "@/lib/chat/types";
import type { Citation } from "@/types/rag";

const KIND_LABEL: Record<Citation["kind"], string> = { section: "Page section", api: "API entry", code: "Code example" };

/**
 * What the documentation search found for one reply: the numbered sources the model was given,
 * which of them the answer cites, and a link to open each one. Counts come from the backend's
 * record of the search, never from the model's text.
 */
export function SourcesPanel({ message }: { message: StoredMessage }) {
  const docs = message.meta.docs;
  if (!docs || docs.status === "skipped") return null;

  if (docs.status !== "used") {
    const text =
      docs.status === "none_found"
        ? "No relevant documentation was found for this question, so this answer is not based on the indexed GTPS documentation."
        : docs.status === "unavailable"
          ? "No documentation is indexed yet, so this answer is not based on the GTPS documentation."
          : "The documentation search failed, so this answer is not based on the GTPS documentation.";
    return (
      <p role="note" data-testid="docs-none" className="mt-2 flex items-start gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {text} {docs.reason ? <span className="block">{docs.reason}</span> : null}
          {docs.identifiers.filter((i) => !i.documented).length > 0 ? (
            <span className="block">Not found in the indexed API entries: {docs.identifiers.filter((i) => !i.documented).map((i) => i.name).join(", ")}</span>
          ) : null}
        </span>
      </p>
    );
  }

  const finished = message.status !== "streaming";
  const cited = new Set(citedNumbers(message.content, docs.citations));
  return (
    <section aria-label="Documentation sources" data-testid="sources" className="mt-3 rounded-md border border-border bg-secondary/30 px-3 py-2 text-xs">
      <h3 className="mb-1 flex items-center gap-1.5 font-medium">
        <BookOpen className="size-3.5" aria-hidden="true" />
        Sources
        <span className="font-normal text-muted-foreground" data-testid="sources-summary">
          {docs.sectionsSent} section{docs.sectionsSent === 1 ? "" : "s"} from {docs.documentsRetrieved} page{docs.documentsRetrieved === 1 ? "" : "s"} · {cited.size} cited in the answer
        </span>
      </h3>
      <ol className="space-y-2">
        {docs.citations.map((c) => (
          <li key={c.n} data-testid="source-item" data-n={c.n} className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-muted-foreground">[{c.n}]</span>
              <Link href={docsHref(c)} className="min-w-0 break-words font-medium text-primary underline underline-offset-2" aria-label={`Open ${c.title}${c.section ? `, ${c.section}` : ""} in the documentation`}>
                {c.title}
                {c.section && c.section !== c.title ? ` › ${c.section}` : ""}
              </Link>
              <Badge variant="muted">{KIND_LABEL[c.kind]}</Badge>
              {finished ? (
                cited.has(c.n) ? <Badge>cited</Badge> : <span className="text-muted-foreground">not cited</span>
              ) : null}
            </div>
            <a href={c.url} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex max-w-full items-center gap-1 break-all text-muted-foreground underline underline-offset-2 hover:text-foreground">
              <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
              {c.url}
            </a>
            {c.excerpt ? (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-muted-foreground">Source excerpt{c.truncated ? " (shortened when sent)" : ""}</summary>
                <p className="mt-1 whitespace-pre-wrap break-words rounded bg-background/60 p-2 font-mono text-[11px] leading-snug">{c.excerpt}</p>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
      {docs.conflicts.length > 0 ? (
        <p role="note" data-testid="docs-conflict" className="mt-2 text-amber-700 dark:text-amber-300">
          Conflicting documentation: {docs.conflicts.map((c) => `${c.name} (sources ${c.sources.map((n) => `[${n}]`).join(" and ")})`).join("; ")}. Check both pages.
        </p>
      ) : null}
      {docs.removedInstructionLines > 0 ? (
        <p role="note" data-testid="docs-removed" className="mt-2 text-amber-700 dark:text-amber-300">
          {docs.removedInstructionLines} line{docs.removedInstructionLines === 1 ? "" : "s"} of documentation text looked like instructions to an AI and {docs.removedInstructionLines === 1 ? "was" : "were"} removed before it was sent.
        </p>
      ) : null}
    </section>
  );
}
