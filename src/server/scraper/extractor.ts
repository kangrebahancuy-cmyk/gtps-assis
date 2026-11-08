import * as cheerio from "cheerio";
import type { Element } from "domhandler";

import {
  detectLanguage,
  parseSignature,
  readEntryDetails,
} from "@/server/scraper/api-parse";
import { sha256 } from "@/server/scraper/hash";
import type { ScraperConfig } from "@/server/scraper/config";
import { resolveDocLink } from "@/server/scraper/url";

export { detectLanguage, parseSignature, readEntryDetails };

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
  content: string;
}

export interface ExtractedPage {
  url: string;
  title: string;
  /** Page category taken from the breadcrumb / nav group, if present. */
  category: string | null;
  rawContent: string;
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

const MAIN_SELECTORS = ["main", "article", '[role="main"]', "#content", ".content"];
const NOISE_SELECTORS = "script, style, noscript, template, svg, iframe, nav, aside, header, footer";


function clean(text: string): string {
  return text.replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function languageOf(el: cheerio.Cheerio<Element>): string | null {
  const classes = `${el.attr("class") ?? ""} ${el.find("code").first().attr("class") ?? ""}`;
  const match = /(?:language|lang)-([\w+-]+)/i.exec(classes);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * Text lines that belong to the same API entry as a <pre>: the siblings inside
 * its container when that container holds only this one code block, otherwise
 * the siblings between the previous code block and this one.
 */
function entryLines(el: cheerio.Cheerio<Element>): string[] {
  const parent = el.parent();
  const group =
    parent.find("pre").length === 1
      ? parent.children().not("pre")
      : el.prevUntil("pre");
  return group
    .toArray()
    .reverse()
    .flatMap((node) => cheerio.load(node as Element).root().text().split("\n"))
    .map((line) => oneLine(line))
    .filter(Boolean);
}

/**
 * Extracts structured content from rendered HTML. The extractor is
 * deliberately structure-agnostic: it relies on semantic tags (headings,
 * tables, pre/code, links) rather than site-specific class names.
 */
export function extractPage(
  html: string,
  pageUrl: string,
  config: Pick<ScraperConfig, "origin" | "pathPrefix">,
): ExtractedPage {
  const $ = cheerio.load(html);

  // Links are collected before noise (sidebar/nav) is removed so the crawler
  // can discover every internal page.
  const docLinks = new Set<string>();
  $("a[href]").each((_, a) => {
    const resolved = resolveDocLink($(a).attr("href") ?? "", pageUrl, config);
    if (resolved) docLinks.add(resolved);
  });

  const title =
    oneLine($("h1").first().text()) ||
    oneLine($("title").first().text()) ||
    pageUrl;

  const category =
    oneLine(
      $('nav[aria-label*="breadcrumb" i] li, .breadcrumb li, [class*="breadcrumb" i] a')
        .first()
        .text(),
    ) || null;

  let root = $("body");
  for (const selector of MAIN_SELECTORS) {
    const found = $(selector).first();
    if (found.length > 0 && clean(found.text()).length > 0) {
      root = found;
      break;
    }
  }

  const rawContent = $.html(root);

  const scope = cheerio.load($.html(root));
  scope(NOISE_SELECTORS).remove();
  const body = scope("body");

  const headings: ExtractedHeading[] = [];
  const sections: ExtractedSection[] = [];
  const tables: ExtractedTable[] = [];
  const codeExamples: ExtractedCode[] = [];
  const links: ExtractedLink[] = [];
  const apiEntries: ExtractedApiEntry[] = [];

  let currentHeading: string | null = null;
  let currentLevel = 0;
  let buffer: string[] = [];
  let position = 0;

  function flush() {
    const content = clean(buffer.join("\n"));
    if (content || currentHeading) {
      sections.push({
        heading: currentHeading,
        level: currentLevel,
        position: position++,
        content,
      });
    }
    buffer = [];
  }

  body.find("*").each((_, node) => {
    const el = scope(node);
    const tag = (node as Element).tagName?.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      flush();
      currentHeading = oneLine(el.text());
      currentLevel = Number(tag.slice(1));
      if (currentHeading) headings.push({ level: currentLevel, text: currentHeading });
    } else if (tag === "p" || tag === "li") {
      if (el.closest("table, pre").length === 0) {
        const text = oneLine(el.text());
        if (text) buffer.push(text);
      }
    }
  });
  flush();

  body.find("table").each((_, table) => {
    const t = scope(table);
    const headers = t
      .find("thead th, tr:first-child th")
      .map((__, th) => oneLine(scope(th).text()))
      .get();
    const rows: string[][] = [];
    t.find("tr").each((__, tr) => {
      const cells = scope(tr)
        .find("td")
        .map((___, td) => oneLine(scope(td).text()))
        .get();
      if (cells.length > 0) rows.push(cells);
    });
    if (headers.length > 0 || rows.length > 0) tables.push({ headers, rows });
  });

  body.find("pre").each((_, pre) => {
    const el = scope(pre);
    const code = el.text().replace(/\s+$/, "");
    if (!code.trim()) return;
    let context: string | null = null;
    const prev = el.prevAll("h1,h2,h3,h4,h5,h6").first();
    if (prev.length > 0) context = oneLine(prev.text()) || null;
    codeExamples.push({
      language: detectLanguage(code, languageOf(el)),
      code,
      context,
    });

    const firstLine = oneLine(code.split("\n")[0] ?? "");
    const parsed = parseSignature(firstLine);
    if (parsed && !apiEntries.some((e) => e.signature === firstLine)) {
      apiEntries.push({
        name: parsed.name,
        signature: firstLine,
        params: parsed.params,
        ...readEntryDetails(entryLines(el), firstLine),
      });
    }
  });

  body.find("a[href]").each((_, a) => {
    const el = scope(a);
    const url = resolveDocLink(el.attr("href") ?? "", pageUrl, config);
    const text = oneLine(el.text());
    if (url && text) links.push({ text, url });
  });

  const cleanedContent = clean(
    sections
      .map((s) => (s.heading ? `${"#".repeat(Math.max(1, s.level))} ${s.heading}\n${s.content}` : s.content))
      .join("\n\n"),
  );

  return {
    url: pageUrl,
    title,
    category,
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

/** Heuristic: the page body is nearly empty, so it is probably client-rendered. */
export function looksClientRendered(html: string): boolean {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = oneLine($("body").text());
  const hasShell = /id=["'](root|app|__next|__nuxt)["']/.test(html);
  return text.length < 200 && (hasShell || /<script/i.test(html));
}
