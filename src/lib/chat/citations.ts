import type { Citation } from "@/types/rag";

/**
 * Which of the numbered sources does a reply actually cite? The model is told to write [1], [2][3]
 * or [1, 2] after statements taken from an excerpt. Only numbers that exist in the list count, and
 * brackets inside code (`t[1]`, fenced blocks) are not citations.
 */
export function citedNumbers(content: string, citations: readonly Pick<Citation, "n">[]): number[] {
  const valid = new Set(citations.map((c) => c.n));
  const prose = content.replace(/(```|~~~)[\s\S]*?(\1|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const found = new Set<number>();
  for (const group of prose.matchAll(/(?<![\w\])])((?:\[\d{1,3}(?:\s*,\s*\d{1,3})*\])+)/g)) {
    for (const n of (group[1] ?? "").match(/\d{1,3}/g) ?? []) if (valid.has(Number(n))) found.add(Number(n));
  }
  return [...found].sort((a, b) => a - b);
}

/** In-app link that opens the cited page (and section) in the documentation viewer. */
export function docsHref(citation: Pick<Citation, "documentId" | "anchor">): string {
  return `/docs?doc=${citation.documentId}${citation.anchor ? `#${encodeURIComponent(citation.anchor)}` : ""}`;
}
