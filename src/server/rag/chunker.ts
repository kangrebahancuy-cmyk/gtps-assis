import { slugifyHeading } from "@/lib/markdown";
import { markdownToPlainText, stripInlineMarkdown } from "@/lib/markdown-plain";
import type { SourceKind } from "@/types/rag";

/**
 * Splits one indexed document into retrievable chunks. A chunk is small enough
 * to be sent to a model on its own and keeps the heading it came from, so a
 * citation can name the exact section.
 *
 *  - section chunks: the page text by heading; long sections are cut at paragraph
 *    boundaries (never inside a fenced code block) with one paragraph of overlap;
 *    tiny sections are merged into the next one so headings never stand alone.
 *  - api chunks: one per API entry (signature, parameters, returns, description).
 *  - code chunks: one per code example, with its context line.
 */

export const MAX_CHUNK_CHARS = 2200;
const MIN_SECTION_CHARS = 60;
const OVERLAP_MAX_CHARS = 300;
const MAX_CODE_CHUNK_CHARS = 3000;

/** Rough token count (characters / 3.6): deliberately on the high side for code. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

export interface ChunkInput {
  title: string;
  sections: Array<{ heading: string | null; level: number; position: number; content: string }>;
  apiEntries: Array<{ name: string; signature: string; params: string[]; returns: string | null; description: string | null }>;
  codeExamples: Array<{ language: string | null; context: string | null; code: string }>;
}

export interface Chunk {
  kind: SourceKind;
  /** Section heading, API name or code context. */
  heading: string | null;
  /** The same heading id the documentation viewer gives the heading. */
  anchor: string | null;
  /** API name, for api chunks. */
  label: string | null;
  language: string | null;
  position: number;
  /** Markdown / code as it will be shown to the model. */
  text: string;
  /** Text as indexed for full-text search (code removed from sections, identifiers added separately). */
  searchText: string;
  tokens: number;
}

const cleanHeading = (heading: string): string => stripInlineMarkdown(heading).replace(/\s+/g, " ").trim();

/** Words inside identifiers: "onPlayerChatCallback" -> "on player chat callback", "Player:getName" -> "player get name". */
export function identifierWords(text: string): string {
  const words = new Set<string>();
  for (const token of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    const split = token
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s]+/)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 2);
    if (split.length > 1) for (const w of split) words.add(w);
    if (words.size > 300) break;
  }
  return [...words].join(" ");
}

/** Paragraph units; a fenced code block is one unit, so it is never cut in the middle by the packer. */
function units(markdown: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = () => {
    const joined = current.join("\n").trim();
    if (joined) out.push(joined);
    current = [];
  };
  for (const line of markdown.split("\n")) {
    const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      current.push(line);
      if (open && line.trim().startsWith(fence) && line.trim() === fence) {
        fence = null;
        flush();
      }
      continue;
    }
    if (open) {
      flush();
      fence = open[1] ?? "```";
      current.push(line);
      continue;
    }
    if (line.trim() === "") flush();
    else current.push(line);
  }
  flush();
  return out;
}

/** A unit longer than the limit (a huge code block or table) is cut at line boundaries. */
function hardSplit(unit: string, max: number): string[] {
  if (unit.length <= max) return [unit];
  const parts: string[] = [];
  let current = "";
  for (const line of unit.split("\n")) {
    if (current && current.length + line.length + 1 > max) {
      parts.push(current);
      current = "";
    }
    current += (current ? "\n" : "") + (line.length > max ? line.slice(0, max) : line);
  }
  if (current) parts.push(current);
  return parts;
}

export function splitText(markdown: string, max = MAX_CHUNK_CHARS): string[] {
  const text = markdown.trim();
  if (text.length <= max) return text ? [text] : [];
  const pieces = units(text).flatMap((u) => hardSplit(u, max));
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const piece of pieces) {
    if (current.length > 0 && size + piece.length + 2 > max) {
      chunks.push(current.join("\n\n"));
      const last = current[current.length - 1] ?? "";
      current = last.length <= OVERLAP_MAX_CHARS && !last.startsWith("```") ? [last] : [];
      size = current.reduce((n, p) => n + p.length + 2, 0);
    }
    current.push(piece);
    size += piece.length + 2;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

function sectionChunks(input: ChunkInput): Chunk[] {
  const chunks: Chunk[] = [];
  const used = new Map<string, number>();
  let carry = "";
  const sections = [...input.sections].sort((a, b) => a.position - b.position);

  const anchors = sections.map((s) => {
    if (!s.heading) return null;
    const base = slugifyHeading(s.heading.replace(/[`*[\]()]/g, ""));
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    return seen === 0 ? base : `${base}-${seen}`;
  });

  const push = (heading: string | null, anchor: string | null, body: string) => {
    for (const part of splitText(body)) {
      chunks.push({
        kind: "section",
        heading: heading ? cleanHeading(heading) : null,
        anchor,
        label: null,
        language: null,
        position: chunks.length,
        text: part,
        searchText: markdownToPlainText(part),
        tokens: estimateTokens(part),
      });
    }
  };

  sections.forEach((section, index) => {
    const text = section.content.trim();
    const heading = section.heading;
    const last = index === sections.length - 1;
    if (!text) {
      if (heading) carry += `${"#".repeat(Math.min(Math.max(section.level, 1), 6))} ${heading}\n\n`;
      if (last && carry.trim()) push(heading, anchors[index] ?? null, carry.trim());
      return;
    }
    if (text.length < MIN_SECTION_CHARS && !last) {
      carry += `${heading ? `${"#".repeat(Math.min(Math.max(section.level, 1), 6))} ${heading}\n\n` : ""}${text}\n\n`;
      return;
    }
    push(heading, anchors[index] ?? null, `${carry}${text}`);
    carry = "";
  });
  return chunks;
}

function apiChunks(input: ChunkInput, start: number): Chunk[] {
  return input.apiEntries.map((e, i) => {
    const lines = [e.name, `Signature: ${e.signature}`];
    lines.push(e.params.length > 0 ? `Parameters: ${e.params.join(", ")}` : "Parameters: none recorded in the index (see the signature)");
    if (e.returns) lines.push(`Returns: ${e.returns}`);
    if (e.description) lines.push(`Description: ${e.description}`);
    const text = lines.join("\n");
    return { kind: "api" as const, heading: e.name, anchor: null, label: e.name, language: null, position: start + i, text, searchText: text, tokens: estimateTokens(text) };
  });
}

function codeChunks(input: ChunkInput, start: number): Chunk[] {
  const out: Chunk[] = [];
  for (const example of input.codeExamples) {
    const heading = example.context?.trim() || input.title;
    for (const part of splitText(example.code, MAX_CODE_CHUNK_CHARS)) {
      const fence = `\`\`\`${example.language ?? ""}\n${part}\n\`\`\``;
      out.push({
        kind: "code",
        heading,
        anchor: null,
        label: null,
        language: example.language,
        position: start + out.length,
        text: fence,
        searchText: `${example.context ?? ""}\n${part}`,
        tokens: estimateTokens(fence),
      });
    }
  }
  return out;
}

/** All chunks of a document, section chunks first. `position` is unique within the document. */
export function chunkDocument(input: ChunkInput): Chunk[] {
  const sections = sectionChunks(input);
  const api = apiChunks(input, sections.length);
  const code = codeChunks(input, sections.length + api.length);
  return [...sections, ...api, ...code];
}
