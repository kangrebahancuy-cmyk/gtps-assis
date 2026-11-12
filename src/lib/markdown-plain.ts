/** Helpers that turn the Markdown we store into plain text (for search and summaries). */

/** [text](url) -> text, `code` -> code, **bold** / *em* -> text. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1$2")
    .replace(/\\\|/g, "|");
}

/**
 * Plain text of a stored document: headings, paragraphs, lists and table cells.
 * Fenced code is dropped on purpose; code has its own search index.
 */
export function markdownToPlainText(markdown: string): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const raw of markdown.split("\n")) {
    const line = raw.trimEnd();
    const open = /^(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && line.startsWith(fence) && line.trim() === fence) fence = null;
      continue;
    }
    if (open) {
      fence = open[1] ?? "```";
      continue;
    }
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/.test(line) && line.includes("-")) continue; // table rule
    let text = line;
    if (text.startsWith("|")) {
      text = text.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim()).join(" ");
    }
    text = text.replace(/^\s{0,6}#{1,6}\s+/, "").replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/^>\s?/, "");
    text = stripInlineMarkdown(text).trim();
    if (text) out.push(text);
  }
  return out.join("\n");
}
