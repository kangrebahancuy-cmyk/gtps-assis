import type { InlineNode, MarkdownBlock, MarkdownListItem, TableAlign } from "@/types";

/**
 * Dependency-free Markdown parser used by the chat and documentation renderers.
 * Supported: headings 1-6, paragraphs, nested ordered/unordered lists, fenced
 * code blocks (``` or ~~~, any length) and GFM tables. Inline: `code`, **bold**,
 * *italic* and [links](https://…). Output is plain data, rendered as React
 * elements (never as raw HTML), and links are limited to http(s).
 */

export function slugifyHeading(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]+/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

const FENCE = /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+]|\d+\.)\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function alignOf(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  return left && right ? "center" : right ? "right" : left ? "left" : null;
}

const isBlockStart = (line: string, next: string | undefined): boolean =>
  FENCE.test(line) ||
  HEADING.test(line) ||
  LIST.test(line) ||
  (line.includes("|") && next !== undefined && TABLE_RULE.test(next) && next.includes("-"));

function parseList(lines: string[], start: number): { block: MarkdownBlock; next: number } {
  interface Frame { indent: number; ordered: boolean; items: MarkdownListItem[] }
  const first = LIST.exec(lines[start] ?? "")!;
  const root: Frame = { indent: (first[1] ?? "").length, ordered: /\d/.test(first[2] ?? ""), items: [] };
  const stack: Frame[] = [root];

  let i = start;
  for (; i < lines.length; i++) {
    const m = LIST.exec(lines[i] ?? "");
    if (!m) break;
    const indent = (m[1] ?? "").length;
    const ordered = /\d/.test(m[2] ?? "");
    while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
    let frame = stack[stack.length - 1]!;
    if (indent > frame.indent) {
      const parent = frame.items[frame.items.length - 1];
      if (parent) {
        frame = { indent, ordered, items: [] };
        parent.children = { ordered, items: frame.items };
        stack.push(frame);
      }
    }
    frame.items.push({ text: m[3] ?? "", children: null });
  }
  return { block: { type: "list", ordered: root.ordered, items: root.items }, next: i };
}

export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  const usedIds = new Map<string, number>();

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[2] ?? "```";
      const codeLines: string[] = [];
      i += 1;
      const closing = new RegExp(`^\\s{0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // closing fence (or end of input)
      blocks.push({ type: "code", language: fence[3] ?? "", code: codeLines.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const text = heading[2] ?? "";
      const base = slugifyHeading(text.replace(/[`*[\]()]/g, ""));
      const seen = usedIds.get(base) ?? 0;
      usedIds.set(base, seen + 1);
      blocks.push({
        type: "heading",
        level: (heading[1] ?? "#").length as 1 | 2 | 3 | 4 | 5 | 6,
        text,
        id: seen === 0 ? base : `${base}-${seen}`,
      });
      i += 1;
      continue;
    }

    const rule = lines[i + 1];
    if (line.includes("|") && rule !== undefined && TABLE_RULE.test(rule) && rule.includes("-")) {
      const header = splitTableRow(line);
      const align = splitTableRow(rule).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim() !== "" && (lines[i] ?? "").includes("|")) {
        const cells = splitTableRow(lines[i] ?? "");
        rows.push(Array.from({ length: header.length }, (_, c) => cells[c] ?? ""));
        i += 1;
      }
      blocks.push({ type: "table", header, align: header.map((_, c) => align[c] ?? null), rows });
      continue;
    }

    if (LIST.test(line)) {
      const { block, next } = parseList(lines, i);
      blocks.push(block);
      i = next;
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim() !== "" && !isBlockStart(lines[i] ?? "", lines[i + 1])) {
      paragraph.push((lines[i] ?? "").trim());
      i += 1;
    }
    if (paragraph.length === 0) {
      // A line that looks like a block start but is not one; keep it as text so we always advance.
      paragraph.push(line.trim());
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

// ---- inline ----------------------------------------------------------------

const LINK = /^\[((?:[^[\]\\]|\\.)*)\]\(([^()\s]+)\)/;

function isSafeHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

export function parseInline(src: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";

    if (ch === "\\" && i + 1 < src.length && "|*`[]()\\".includes(src[i + 1] ?? "")) {
      buffer += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      let run = 1;
      while (src[i + run] === "`") run += 1;
      const ticks = "`".repeat(run);
      const end = src.indexOf(ticks, i + run);
      if (end > i + run) {
        flush();
        const inner = src.slice(i + run, end);
        nodes.push({ type: "code", text: run > 1 ? inner.replace(/^ | $/g, "") : inner });
        i = end + run;
        continue;
      }
    }

    if (ch === "[") {
      const m = LINK.exec(src.slice(i));
      if (m) {
        flush();
        const children = parseInline(m[1] ?? "");
        const href = m[2] ?? "";
        if (isSafeHref(href)) nodes.push({ type: "link", href, children });
        else nodes.push(...children);
        i += m[0].length;
        continue;
      }
    }

    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        nodes.push({ type: "strong", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (ch === "*" && src[i + 1] !== "*" && src[i + 1] !== " " && src[i + 1] !== undefined) {
      let end = i + 1;
      while ((end = src.indexOf("*", end)) !== -1 && (src[end - 1] === " " || src[end + 1] === "*")) end += 1;
      if (end > i + 1) {
        flush();
        nodes.push({ type: "em", children: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return nodes;
}
