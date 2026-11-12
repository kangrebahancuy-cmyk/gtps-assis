/**
 * Minimal DOM helpers over htmlparser2/domhandler-shaped plain objects. The
 * extractor only needs these fields, so it can be tested without an HTML parser
 * installed and works unchanged on Cheerio's nodes.
 */
export interface DomNode {
  type: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: DomNode[];
}

export const isText = (n: DomNode): boolean => n.type === "text";

export const isElement = (n: DomNode): boolean =>
  (n.type === "tag" || n.type === "script" || n.type === "style") && typeof n.name === "string";

export const nameOf = (n: DomNode): string => (n.name ?? "").toLowerCase();

export const kids = (n: DomNode): DomNode[] => n.children ?? [];

export const attr = (n: DomNode, key: string): string | undefined => n.attribs?.[key];

export const norm = (s: string): string => s.replace(/ /g, " ").replace(/\s+/g, " ").trim();

/** Text of a subtree. <br> becomes a newline; script/style content is ignored. */
export function textOf(node: DomNode): string {
  if (isText(node)) return node.data ?? "";
  if (!isElement(node)) return "";
  const name = nameOf(node);
  if (name === "script" || name === "style") return "";
  if (name === "br") return "\n";
  return kids(node).map(textOf).join("");
}

/** All descendant elements matching `test`, in document order. */
export function findAll(root: DomNode, test: (el: DomNode) => boolean): DomNode[] {
  const found: DomNode[] = [];
  const visit = (node: DomNode) => {
    for (const child of kids(node)) {
      if (isElement(child) && test(child)) found.push(child);
      visit(child);
    }
  };
  visit(root);
  return found;
}

export function findFirst(root: DomNode, test: (el: DomNode) => boolean): DomNode | null {
  return findAll(root, test)[0] ?? null;
}

export const classTokens = (n: DomNode): string[] => (attr(n, "class") ?? "").split(/\s+/).filter(Boolean);

/** Elements that start/end a visual line; used to turn a subtree into text lines. */
export const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "main", "ul", "ol", "li", "pre", "table", "thead", "tbody", "tfoot",
  "tr", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "dl", "dt", "dd", "figure", "figcaption",
  "details", "summary", "fieldset", "header", "footer", "nav", "aside",
]);

/** Like textOf, but block elements break lines so list items and cells stay apart. */
function blockText(node: DomNode): string {
  if (isText(node)) return node.data ?? "";
  if (!isElement(node)) return "";
  const name = nameOf(node);
  if (name === "script" || name === "style") return "";
  if (name === "br") return "\n";
  const inner = kids(node).map(blockText).join("");
  return BLOCK_TAGS.has(name) || name === "td" || name === "th" ? `\n${inner}\n` : inner;
}

/** Non-empty, whitespace-normalised text lines of a subtree. */
export function textLines(node: DomNode): string[] {
  return blockText(node)
    .split("\n")
    .map(norm)
    .filter(Boolean);
}
