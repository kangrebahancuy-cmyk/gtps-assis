/**
 * A tiny HTML parser for tests only, producing domhandler-shaped nodes so the
 * pure-DOM extractor can be tested where Cheerio is not installed. It handles
 * well-formed fixtures (quoted/unquoted attributes, void tags, comments, raw
 * script/style text, common entities). It is NOT a spec-compliant parser; once
 * Cheerio is installed, tests/extractor.test.ts cross-checks the two.
 */
import type { DomNode } from "@/server/scraper/dom";

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "source", "wbr"]);
const RAW = new Set(["script", "style"]);

function decode(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

function encode(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function parseHtml(html: string): DomNode {
  const root: DomNode = { type: "root", children: [] };
  const stack: DomNode[] = [root];
  const top = () => stack[stack.length - 1]!;
  const append = (node: DomNode) => top().children!.push(node);

  const tag = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/gi;
  let last = 0;
  let match: RegExpExecArray | null;

  while ((match = tag.exec(html)) !== null) {
    if (match.index > last) append({ type: "text", data: decode(html.slice(last, match.index)) });
    last = tag.lastIndex;

    if (match[0].startsWith("<!")) continue;
    if (match[1]) {
      const name = match[1].toLowerCase();
      const at = stack.map((n) => n.name).lastIndexOf(name);
      if (at > 0) stack.length = at;
      continue;
    }

    const name = (match[2] ?? "").toLowerCase();
    const attribs: Record<string, string> = {};
    for (const a of (match[3] ?? "").matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      attribs[(a[1] ?? "").toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    const type = name === "script" ? "script" : name === "style" ? "style" : "tag";
    const node: DomNode = { type, name, attribs, children: [] };
    append(node);

    if (RAW.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, last);
      const end = close === -1 ? html.length : close;
      if (end > last) node.children!.push({ type: "text", data: html.slice(last, end) });
      const closeEnd = close === -1 ? html.length : html.indexOf(">", close) + 1;
      tag.lastIndex = last = closeEnd;
    } else if (!VOID.has(name) && match[4] !== "/") {
      stack.push(node);
    }
  }
  if (last < html.length) append({ type: "text", data: decode(html.slice(last)) });
  return root;
}

export function serializeHtml(node: DomNode): string {
  if (node.type === "text") return encode(node.data ?? "");
  const attrs = Object.entries(node.attribs ?? {})
    .map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`)
    .join("");
  const inner = (node.children ?? []).map(serializeHtml).join("");
  if (node.type === "root") return inner;
  return VOID.has(node.name ?? "") ? `<${node.name}${attrs}>` : `<${node.name}${attrs}>${inner}</${node.name}>`;
}
