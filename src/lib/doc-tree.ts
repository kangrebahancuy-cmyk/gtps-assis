import type { DocTreeNode } from "@/types/docs";

/** Pure helpers over the documentation tree returned by /api/docs/tree. */

export function firstDocumentId(nodes: readonly DocTreeNode[]): number | null {
  for (const node of nodes) {
    if (node.documentId !== null) return node.documentId;
    const inner = firstDocumentId(node.children);
    if (inner !== null) return inner;
  }
  return null;
}

/** Node ids from the root down to (and including) the node that opens `documentId`. */
export function pathToDocument(nodes: readonly DocTreeNode[], documentId: number): string[] | null {
  for (const node of nodes) {
    if (node.documentId === documentId) return [node.id];
    const inner = pathToDocument(node.children, documentId);
    if (inner) return [node.id, ...inner];
  }
  return null;
}

/** Original URL -> document id, for opening in-document links inside the explorer. */
export function urlIndex(nodes: readonly DocTreeNode[], into = new Map<string, number>()): Map<string, number> {
  for (const node of nodes) {
    if (node.url !== null && node.documentId !== null) into.set(node.url, node.documentId);
    urlIndex(node.children, into);
  }
  return into;
}

/** Same URL normalisation the crawler uses: no hash, no trailing slash. */
export function comparableUrl(href: string): string {
  try {
    const url = new URL(href);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return href;
  }
}
