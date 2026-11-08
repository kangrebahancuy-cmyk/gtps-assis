import type { MarkdownBlock } from "@/types";

/**
 * Minimal, dependency-free Markdown block parser used by the message and
 * documentation renderers. It intentionally supports only the constructs the
 * UI needs for now: headings, paragraphs, flat lists, and fenced code blocks.
 * Output is plain data, rendered as React elements (never as raw HTML).
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const language = fence[1] ?? "";
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "");
        i += 1;
      }
      i += 1; // skip closing fence
      blocks.push({ type: "code", language, code: codeLines.join("\n") });
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length as 1 | 2 | 3;
      blocks.push({ type: "heading", level, text: heading[2] ?? "" });
      i += 1;
      continue;
    }

    const listMatch = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2] ?? "");
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i] ?? "");
        if (!m) break;
        items.push(m[3] ?? "");
        i += 1;
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] ?? "").trim() !== "" &&
      !/^```/.test(lines[i] ?? "") &&
      !/^#{1,3}\s+/.test(lines[i] ?? "") &&
      !/^(\s*)([-*]|\d+\.)\s+/.test(lines[i] ?? "")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}
