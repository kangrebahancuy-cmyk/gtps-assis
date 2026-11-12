/**
 * Pure-DOM page extraction. It works on domhandler-shaped nodes, so it has no
 * dependency on Cheerio (extractor.ts is the thin wrapper that parses HTML),
 * and it can be unit-tested with a tiny parser.
 *
 * The extractor relies on semantic tags (headings, lists, tables, pre/code,
 * links) rather than site-specific class names. The page is converted to
 * Markdown, which is what the documentation viewer renders.
 */
import { detectLanguage, parseSignature, readEntryDetails } from "@/server/scraper/api-parse";
import type { ScraperConfig } from "@/server/scraper/config";
import {
  attr,
  classTokens,
  findAll,
  findFirst,
  isElement,
  isText,
  kids,
  nameOf,
  norm,
  textLines,
  textOf,
  type DomNode,
} from "@/server/scraper/dom";
import { sha256 } from "@/server/scraper/hash";
import { normalizeUrl, resolveDocLink } from "@/server/scraper/url";

export interface ExtractedHeading {
  level: number;
  text: string;
}

export interface ExtractedTable {
  headers: string[];
  rows: string[][];
}

export interface ExtractedCode {
  language: string | null;
  code: string;
  /** Heading text the code block appeared under, if any. */
  context: string | null;
}

export interface ExtractedApiEntry {
  /** e.g. "Player:getName" or "onPlayerChatCallback". */
  name: string;
  signature: string;
  params: string[];
  description: string | null;
  returns: string | null;
}

export interface ExtractedLink {
  text: string;
  url: string;
}

export interface ExtractedSection {
  heading: string | null;
  level: number;
  /** Position in document order, used to preserve hierarchy. */
  position: number;
  /** Markdown of the blocks between this heading and the next one. */
  content: string;
}

export interface ExtractedPage {
  url: string;
  title: string;
  /** Nearest navigation group of the page (last element of categoryPath), if known. */
  category: string | null;
  /** Navigation groups from outermost to innermost. Empty when the site gives none. */
  categoryPath?: string[];
  rawContent: string;
  /** The page body as Markdown. */
  cleanedContent: string;
  contentHash: string;
  headings: ExtractedHeading[];
  sections: ExtractedSection[];
  tables: ExtractedTable[];
  codeExamples: ExtractedCode[];
  apiEntries: ExtractedApiEntry[];
  links: ExtractedLink[];
  /** Discovered internal documentation URLs (normalized, de-duplicated). */
  docLinks: string[];
}

type UrlConfig = Pick<ScraperConfig, "origin" | "pathPrefix">;

const NOISE = new Set([
  "script", "style", "noscript", "template", "svg", "iframe", "nav", "aside", "button", "form",
  "select", "input", "textarea",
]);

const INLINE = new Set([
  "a", "span", "strong", "b", "em", "i", "code", "kbd", "samp", "small", "sub", "sup", "mark", "abbr",
  "u", "s", "del", "ins", "br", "img", "label", "time", "cite", "q", "var", "bdi",
]);

const HEADING = /^h([1-6])$/;
const GENERIC_GROUP = /^(docs?|documentation|menu|navigation|table of contents|on this page|search|home)$/i;

const cleanSpaces = (text: string): string => text.replace(/ /g, " ").replace(/[ \t\r\n]+/g, " ");

function headingText(node: DomNode): string {
  return norm(textOf(node)).replace(/^[#¶§]\s+|\s+[#¶§]$/g, "").trim();
}

/** Noise is dropped; header/footer are kept only when they carry a heading (page titles). */
function isNoise(node: DomNode): boolean {
  const name = nameOf(node);
  if (NOISE.has(name)) return true;
  if (name === "header" || name === "footer") {
    return findFirst(node, (el) => HEADING.test(nameOf(el))) === null;
  }
  return false;
}

/** Depth-first walk that never descends into noise. */
function walk(root: DomNode, visit: (el: DomNode, parent: DomNode) => void): void {
  const step = (node: DomNode) => {
    for (const child of kids(node)) {
      if (!isElement(child) || isNoise(child)) continue;
      visit(child, node);
      step(child);
    }
  };
  step(root);
}

// ---- inline Markdown --------------------------------------------------------

function absoluteHref(href: string | undefined, pageUrl: string): string | null {
  const value = (href ?? "").trim();
  if (!value || value.startsWith("#") || /^(javascript|mailto|tel):/i.test(value)) return null;
  try {
    return new URL(value, pageUrl).toString().replace(/ /g, "%20").replace(/\)/g, "%29");
  } catch {
    return null;
  }
}

function inlineMd(nodes: readonly DomNode[], pageUrl: string): string {
  let out = "";
  for (const node of nodes) {
    if (isText(node)) {
      out += cleanSpaces(node.data ?? "");
      continue;
    }
    if (!isElement(node) || isNoise(node)) continue;
    const name = nameOf(node);
    const inner = () => inlineMd(kids(node), pageUrl);
    if (name === "br") out += " ";
    else if (name === "img") out += attr(node, "alt") ?? "";
    else if (name === "code" || name === "kbd" || name === "samp") {
      const text = norm(textOf(node));
      if (text) out += text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
    } else if (name === "strong" || name === "b") {
      const text = inner().trim();
      if (text) out += `**${text}**`;
    } else if (name === "em" || name === "i") {
      const text = inner().trim();
      if (text) out += `*${text}*`;
    } else if (name === "a") {
      const text = inner().trim();
      const href = absoluteHref(attr(node, "href"), pageUrl);
      if (text) out += href ? `[${text.replace(/[[\]]/g, "")}](${href})` : text;
    } else out += inner();
  }
  return out;
}

const paragraph = (nodes: readonly DomNode[], pageUrl: string): string => inlineMd(nodes, pageUrl).trim();

// ---- blocks -----------------------------------------------------------------

type Item =
  | { kind: "heading"; level: number; text: string }
  | { kind: "md"; text: string }
  | { kind: "code"; language: string | null; code: string }
  | { kind: "table"; table: ExtractedTable; md: string };

function languageOf(pre: DomNode): string | null {
  const code = findFirst(pre, (el) => nameOf(el) === "code");
  const classes = `${attr(pre, "class") ?? ""} ${code ? attr(code, "class") ?? "" : ""}`;
  const match = /(?:language|lang)-([\w+-]+)/i.exec(classes);
  const declared = match?.[1] ?? attr(pre, "data-language") ?? attr(pre, "data-lang") ?? (code ? attr(code, "data-language") : undefined);
  return declared ? declared.toLowerCase() : null;
}

function codeText(pre: DomNode): string {
  return textOf(pre).replace(/\r\n?/g, "\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

function fence(code: string, language: string | null): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  const mark = "`".repeat(Math.max(3, longest + 1));
  return `${mark}${language ?? ""}\n${code}\n${mark}`;
}

function cellMd(cell: DomNode, pageUrl: string): string {
  return paragraph(kids(cell), pageUrl).replace(/\|/g, "\\|");
}

function buildTable(table: DomNode, pageUrl: string): Item | null {
  const rowsEl = findAll(table, (el) => nameOf(el) === "tr");
  const parsed = rowsEl
    .map((tr) => ({
      tr,
      cells: kids(tr).filter((c) => isElement(c) && (nameOf(c) === "td" || nameOf(c) === "th")),
    }))
    .filter((r) => r.cells.length > 0);
  if (parsed.length === 0) return null;

  const inThead = (tr: DomNode) => findAll(table, (el) => nameOf(el) === "thead").some((h) => kids(h).includes(tr));
  const headerRow =
    parsed.find((r) => inThead(r.tr)) ?? (parsed[0] && parsed[0].cells.every((c) => nameOf(c) === "th") ? parsed[0] : null);
  const bodyRows = parsed.filter((r) => r !== headerRow);

  const plain = (cells: DomNode[]) => cells.map((c) => norm(textOf(c)));
  const md = (cells: DomNode[]) => cells.map((c) => cellMd(c, pageUrl));

  const headers = headerRow ? plain(headerRow.cells) : [];
  const rows = bodyRows.map((r) => plain(r.cells));

  // GFM needs a header row; when the HTML has none, the first row plays that role.
  const mdHeader = headerRow ? md(headerRow.cells) : md((bodyRows[0] ?? parsed[0])!.cells);
  const mdBody = (headerRow ? bodyRows : bodyRows.slice(1)).map((r) => md(r.cells));
  const width = Math.max(mdHeader.length, ...mdBody.map((r) => r.length));
  const pad = (cells: string[]) => [...cells, ...Array<string>(width - cells.length).fill("")];
  const line = (cells: string[]) => `| ${pad(cells).join(" | ")} |`;
  const text = [line(mdHeader), line(Array<string>(width).fill("---")), ...mdBody.map(line)].join("\n");

  return { kind: "table", table: { headers, rows }, md: text };
}

function listMd(list: DomNode, pageUrl: string, depth: number): string[] {
  const ordered = nameOf(list) === "ol";
  const lines: string[] = [];
  let index = Number(attr(list, "start") ?? 1) || 1;
  for (const li of kids(list).filter((c) => isElement(c) && nameOf(c) === "li")) {
    const marker = ordered ? `${index++}.` : "-";
    const indent = "  ".repeat(depth);
    const inline: DomNode[] = [];
    const nested: string[] = [];
    for (const child of kids(li)) {
      const name = isElement(child) ? nameOf(child) : "";
      if (name === "ul" || name === "ol") nested.push(...listMd(child, pageUrl, depth + 1));
      else if (name === "pre") {
        const code = codeText(child);
        if (code) nested.push(...fence(code, detectLanguage(code, languageOf(child))).split("\n").map((l) => `${indent}  ${l}`));
      } else inline.push(child);
    }
    lines.push(`${indent}${marker} ${paragraph(inline, pageUrl)}`.trimEnd(), ...nested);
  }
  return lines;
}

function collectItems(parent: DomNode, pageUrl: string, items: Item[]): void {
  let run: DomNode[] = [];
  const flushRun = () => {
    const text = paragraph(run, pageUrl);
    if (text) items.push({ kind: "md", text });
    run = [];
  };

  for (const node of kids(parent)) {
    if (isText(node)) {
      run.push(node);
      continue;
    }
    if (!isElement(node) || isNoise(node)) continue;
    const name = nameOf(node);
    if (INLINE.has(name)) {
      run.push(node);
      continue;
    }
    flushRun();

    const heading = HEADING.exec(name);
    if (heading) {
      const text = headingText(node);
      if (text) items.push({ kind: "heading", level: Number(heading[1]), text });
    } else if (name === "p" || name === "dt" || name === "dd" || name === "figcaption" || name === "summary") {
      const text = paragraph(kids(node), pageUrl);
      if (text) items.push({ kind: "md", text });
    } else if (name === "ul" || name === "ol") {
      const lines = listMd(node, pageUrl, 0);
      if (lines.length > 0) items.push({ kind: "md", text: lines.join("\n") });
    } else if (name === "pre") {
      const code = codeText(node);
      if (code.trim()) items.push({ kind: "code", language: detectLanguage(code, languageOf(node)), code });
    } else if (name === "table") {
      const table = buildTable(node, pageUrl);
      if (table) items.push(table);
    } else if (name === "hr") {
      // decorative
    } else collectItems(node, pageUrl, items);
  }
  flushRun();
}

// ---- navigation category ---------------------------------------------------

function isNavContainer(el: DomNode): boolean {
  const name = nameOf(el);
  return (
    name === "nav" ||
    name === "aside" ||
    attr(el, "role") === "navigation" ||
    classTokens(el).some((c) => /sidebar|sidenav|side-nav|docs-nav/i.test(c))
  );
}

/** Ancestor chain from `root` down to the first node accepted by `test`. */
function pathTo(root: DomNode, test: (el: DomNode) => boolean): DomNode[] | null {
  for (const child of kids(root)) {
    if (!isElement(child)) continue;
    if (test(child)) return [root, child];
    const rest = pathTo(child, test);
    if (rest) return [root, ...rest];
  }
  return null;
}

const looksLikeLabel = (el: DomNode): boolean =>
  HEADING.test(nameOf(el)) ||
  classTokens(el).some((c) => /(^|-)(label|title|heading|group|category)(-|$)/i.test(c));

function labelText(nodes: readonly DomNode[]): string | null {
  const text = norm(nodes.map(textOf).join(" "));
  return text && text.length <= 60 && !GENERIC_GROUP.test(text) ? text : null;
}

/**
 * The sidebar groups that contain the page's own link, outermost first. Handles
 * <details><summary>, <li>Group<ul>…</ul></li> and heading/label siblings.
 */
function navigationGroups(doc: DomNode, pageUrl: string, config: UrlConfig): string[] {
  const self = normalizeUrl(pageUrl);
  const isSelfLink = (el: DomNode) =>
    nameOf(el) === "a" && resolveDocLink(attr(el, "href") ?? "", pageUrl, config) === self;

  for (const container of findAll(doc, isNavContainer)) {
    const path = pathTo(container, isSelfLink);
    if (!path) continue;

    const labels: string[] = [];
    for (let i = path.length - 2; i >= 0; i--) {
      const ancestor = path[i]!;
      const child = path[i + 1]!;
      const children = kids(ancestor).filter(isElement);
      const before = children.slice(0, children.indexOf(child));
      let label: string | null = null;

      if (nameOf(ancestor) === "details") {
        const summary = children.find((c) => nameOf(c) === "summary");
        label = summary ? labelText([summary]) : null;
      } else if (/^(ul|ol)$/.test(nameOf(child)) && before.length > 0 && nameOf(ancestor) === "li") {
        label = labelText(before.filter((b) => !/^(ul|ol)$/.test(nameOf(b))));
      } else {
        const heading = [...before].reverse().find((b) => looksLikeLabel(b) && !findFirst(b, (e) => nameOf(e) === "a"));
        label = heading ? labelText([heading]) : null;
      }
      if (label && labels[labels.length - 1] !== label) labels.push(label);
    }
    if (labels.length > 0) return labels.reverse().slice(0, 3);
  }
  return [];
}

function breadcrumbGroups(doc: DomNode, title: string): string[] {
  const crumbs = findAll(
    doc,
    (el) =>
      (nameOf(el) === "nav" && /breadcrumb/i.test(attr(el, "aria-label") ?? "")) ||
      classTokens(el).some((c) => /breadcrumb/i.test(c)),
  )[0];
  if (!crumbs) return [];
  const items = findAll(crumbs, (el) => nameOf(el) === "li").map((li) => norm(textOf(li)));
  const names = (items.length > 0 ? items : findAll(crumbs, (el) => nameOf(el) === "a").map((a) => norm(textOf(a)))).filter(Boolean);
  return names.filter((n) => n !== title && !GENERIC_GROUP.test(n)).slice(0, 3);
}

// ---- API entries -----------------------------------------------------------

/**
 * Text lines that belong to the same API entry as a <pre>: the siblings inside
 * its container when that container holds only this one code block, otherwise
 * the siblings between the previous code block and this one.
 */
function entryLines(pre: DomNode, parent: DomNode): string[] {
  const siblings = kids(parent).filter(isElement);
  const isPre = (el: DomNode) => nameOf(el) === "pre";
  let group: DomNode[];
  if (findAll(parent, isPre).length === 1) {
    group = siblings.filter((s) => !isPre(s));
  } else {
    group = [];
    for (let i = siblings.indexOf(pre) - 1; i >= 0; i--) {
      const sibling = siblings[i]!;
      if (isPre(sibling)) break;
      group.unshift(sibling);
    }
  }
  return group.flatMap(textLines);
}

// ---- main ------------------------------------------------------------------

function findMain(doc: DomNode): DomNode {
  const tests: Array<(el: DomNode) => boolean> = [
    (el) => nameOf(el) === "main",
    (el) => nameOf(el) === "article",
    (el) => attr(el, "role") === "main",
    (el) => attr(el, "id") === "content",
    (el) => classTokens(el).includes("content"),
  ];
  for (const test of tests) {
    const found = findFirst(doc, test);
    if (found && norm(textOf(found)).length > 0) return found;
  }
  return findFirst(doc, (el) => nameOf(el) === "body") ?? doc;
}

export function extractFromDom(
  doc: DomNode,
  pageUrl: string,
  config: UrlConfig,
  serialize: (node: DomNode) => string,
): ExtractedPage {
  // Links are collected before navigation is dropped so the crawler discovers every page.
  const docLinks = new Set<string>();
  for (const a of findAll(doc, (el) => nameOf(el) === "a" && attr(el, "href") !== undefined)) {
    const resolved = resolveDocLink(attr(a, "href") ?? "", pageUrl, config);
    if (resolved) docLinks.add(resolved);
  }

  const h1 = findFirst(doc, (el) => nameOf(el) === "h1");
  const titleTag = findFirst(doc, (el) => nameOf(el) === "title");
  const title = (h1 && headingText(h1)) || (titleTag && norm(textOf(titleTag))) || pageUrl;

  const main = findMain(doc);
  const rawContent = serialize(main);

  const items: Item[] = [];
  collectItems(main, pageUrl, items);

  // Sections and the Markdown body, in document order.
  const headings: ExtractedHeading[] = [];
  const sections: ExtractedSection[] = [];
  const tables: ExtractedTable[] = [];
  const blocks: string[] = [];
  let heading: string | null = null;
  let level = 0;
  let buffer: string[] = [];
  const flush = () => {
    const content = buffer.join("\n\n").trim();
    if (content || heading) sections.push({ heading, level, position: sections.length, content });
    buffer = [];
  };
  for (const item of items) {
    if (item.kind === "heading") {
      flush();
      heading = item.text;
      level = item.level;
      headings.push({ level: item.level, text: item.text });
      blocks.push(`${"#".repeat(item.level)} ${item.text}`);
      continue;
    }
    const text = item.kind === "md" ? item.text : item.kind === "table" ? item.md : fence(item.code, item.language);
    if (item.kind === "table") tables.push(item.table);
    buffer.push(text);
    blocks.push(text);
  }
  flush();
  const cleanedContent = blocks.join("\n\n").trim();

  // Code examples and API entries: every <pre>, with the heading it sits under.
  const codeExamples: ExtractedCode[] = [];
  const apiEntries: ExtractedApiEntry[] = [];
  let context: string | null = null;
  const visitRoot = (el: DomNode, parent: DomNode) => {
    const name = nameOf(el);
    if (HEADING.test(name)) {
      context = headingText(el) || null;
      return;
    }
    if (name !== "pre") return;
    const code = codeText(el);
    if (!code.trim()) return;
    codeExamples.push({ language: detectLanguage(code, languageOf(el)), code, context });

    const firstLine = norm(code.split("\n")[0] ?? "");
    const parsed = parseSignature(firstLine);
    if (parsed && !apiEntries.some((e) => e.signature === firstLine)) {
      apiEntries.push({
        name: parsed.name,
        signature: firstLine,
        params: parsed.params,
        ...readEntryDetails(entryLines(el, parent), firstLine),
      });
    }
  };
  walk(main, visitRoot);

  const links: ExtractedLink[] = [];
  const collectLinks = (el: DomNode) => {
    if (nameOf(el) !== "a") return;
    const url = resolveDocLink(attr(el, "href") ?? "", pageUrl, config);
    const text = norm(textOf(el));
    if (url && text) links.push({ text, url });
  };
  walk(main, collectLinks);

  const groups = navigationGroups(doc, pageUrl, config);
  const categoryPath = groups.length > 0 ? groups : breadcrumbGroups(doc, title);

  return {
    url: pageUrl,
    title,
    category: categoryPath[categoryPath.length - 1] ?? null,
    categoryPath,
    rawContent,
    cleanedContent,
    contentHash: sha256(cleanedContent),
    headings,
    sections,
    tables,
    codeExamples,
    apiEntries,
    links,
    docLinks: [...docLinks],
  };
}
