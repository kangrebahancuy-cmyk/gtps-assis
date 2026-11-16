/** Finds the Lua script inside a model reply (markdown). Pure: used by the server check and by the UI actions. */

export interface CodeBlock {
  lang: string;
  code: string;
  /** The closing fence was seen (false while a reply is still streaming). */
  closed: boolean;
  /** Offsets of the whole block (fences included) in the markdown. */
  start: number;
  end: number;
}

export function codeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const open = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.-]*)[^\n]*\n/gm;
  let m: RegExpExecArray | null;
  while ((m = open.exec(markdown)) !== null) {
    const fence = m[1] as string;
    const bodyStart = m.index + m[0].length;
    const close = new RegExp(`^[ \\t]{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`, "m");
    const rest = markdown.slice(bodyStart);
    const c = close.exec(rest);
    const code = c ? rest.slice(0, c.index) : rest;
    const end = c ? bodyStart + c.index + c[0].length : markdown.length;
    blocks.push({ lang: (m[2] ?? "").toLowerCase(), code: code.replace(/\n$/, ""), closed: !!c, start: m.index, end });
    open.lastIndex = end;
  }
  return blocks;
}

/**
 * The script of a reply: the longest block labelled lua. Unlabelled blocks are used only when no block
 * is labelled, because installation and usage sections often contain console snippets.
 */
export function extractScript(markdown: string): CodeBlock | null {
  const blocks = codeBlocks(markdown).filter((b) => b.code.trim().length > 0);
  const longest = (list: CodeBlock[]) => list.reduce<CodeBlock | null>((best, b) => (best === null || b.code.length > best.code.length ? b : best), null);
  return longest(blocks.filter((b) => b.lang === "lua")) ?? longest(blocks.filter((b) => b.lang === ""));
}
