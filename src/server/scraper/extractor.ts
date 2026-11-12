import * as cheerio from "cheerio";

import { detectLanguage, parseSignature, readEntryDetails } from "@/server/scraper/api-parse";
import type { ScraperConfig } from "@/server/scraper/config";
import type { DomNode } from "@/server/scraper/dom";
import { extractFromDom } from "@/server/scraper/extract-dom";

export { detectLanguage, parseSignature, readEntryDetails };
export type {
  ExtractedApiEntry,
  ExtractedCode,
  ExtractedHeading,
  ExtractedLink,
  ExtractedPage,
  ExtractedSection,
  ExtractedTable,
} from "@/server/scraper/extract-dom";
import type { ExtractedPage } from "@/server/scraper/extract-dom";

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Extracts structured content (Markdown body, headings, tables, code, API
 * entries, links, navigation category) from rendered HTML. Cheerio only parses
 * and serializes here; the extraction logic lives in extract-dom.ts.
 */
export function extractPage(
  html: string,
  pageUrl: string,
  config: Pick<ScraperConfig, "origin" | "pathPrefix">,
): ExtractedPage {
  const $ = cheerio.load(html);
  // Cheerio's nodes are domhandler nodes, which have exactly the fields DomNode reads.
  const root = $.root()[0] as unknown as DomNode;
  return extractFromDom(root, pageUrl, config, (node) => $.html(node as never));
}

/** Heuristic: the page body is nearly empty, so it is probably client-rendered. */
export function looksClientRendered(html: string): boolean {
  const $ = cheerio.load(html);
  $("script, style, noscript").remove();
  const text = oneLine($("body").text());
  const hasShell = /id=["'](root|app|__next|__nuxt)["']/.test(html);
  return text.length < 200 && (hasShell || /<script/i.test(html));
}
