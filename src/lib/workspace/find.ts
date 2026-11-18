/** Plain-text find and replace used by the basic (non-Monaco) editor. Monaco has its own find widget. */

/** Start offsets of every non-overlapping match of `query` in `text` (empty query: none). */
export function findAll(text: string, query: string, caseSensitive = false): number[] {
  if (query === "") return [];
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The match at or after `from` (wrapping to the first); with `backwards`, the match strictly before `from` (wrapping to the last). */
export function pickMatch(matches: readonly number[], from: number, backwards = false): number | null {
  if (matches.length === 0) return null;
  if (backwards) return [...matches].reverse().find((m) => m < from) ?? matches[matches.length - 1] ?? null;
  return matches.find((m) => m >= from) ?? matches[0] ?? null;
}

export interface Replaced {
  text: string;
  count: number;
}

export function replaceAll(text: string, query: string, replacement: string, caseSensitive = false): Replaced {
  const matches = findAll(text, query, caseSensitive);
  if (matches.length === 0) return { text, count: 0 };
  let out = "";
  let last = 0;
  for (const at of matches) {
    out += text.slice(last, at) + replacement;
    last = at + query.length;
  }
  return { text: out + text.slice(last), count: matches.length };
}

/** Replaces the single match that starts at `at`. */
export function replaceAt(text: string, at: number, length: number, replacement: string): string {
  return text.slice(0, at) + replacement + text.slice(at + length);
}

/** 1-based line and column of an offset. */
export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const line = before.split("\n").length;
  return { line, column: offset - (before.lastIndexOf("\n") + 1) + 1 };
}

/** Offset of the start of a 1-based line (clamped to the file). */
export function offsetOfLine(text: string, line: number, column = 1): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + Math.max(0, column - 1), text.length);
}
