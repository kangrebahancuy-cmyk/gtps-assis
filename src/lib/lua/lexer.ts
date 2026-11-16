/**
 * A Lua 5.1-5.4 lexer (a superset: it accepts `goto`, `//`, bitwise operators and `<const>`
 * attributes). It exists so scripts can be checked without a Lua binary, on the server and in
 * the browser. It reports the FIRST lexical error, like the real compiler.
 */

export type TokenType = "name" | "keyword" | "number" | "string" | "op" | "eof";

export interface Token {
  type: TokenType;
  /** Source text of the token (for strings: the decoded content is in `value`). */
  text: string;
  /** Decoded value of a string token; the same as `text` for everything else. */
  value: string;
  line: number;
  column: number;
  /** Offsets into the source: [start, end). */
  start: number;
  end: number;
}

export class LuaSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

export const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "goto", "if", "in",
  "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
]);

const OPERATORS = [
  "...", "<<", ">>", "//", "==", "~=", "<=", ">=", "::", "..",
  "+", "-", "*", "/", "%", "^", "#", "&", "~", "|", "<", ">", "=", "(", ")", "{", "}", "[", "]", ";", ":", ",", ".",
];

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
const isHex = (c: string | undefined): boolean => c !== undefined && /[0-9a-fA-F]/.test(c);
const isNameStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isNameChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let line = 1;
  let lineStart = 0;

  const col = (offset = pos): number => offset - lineStart + 1;
  const fail = (message: string, at = pos): never => {
    throw new LuaSyntaxError(message, line, col(at));
  };
  const newline = (index: number) => {
    // handles \n, \r, \r\n and \n\r as one line break
    const c = source[index];
    const next = source[index + 1];
    const len = (c === "\n" && next === "\r") || (c === "\r" && next === "\n") ? 2 : 1;
    line += 1;
    lineStart = index + len;
    return len;
  };

  /** Reads `[==[ ... ]==]` starting at `[`; returns the content or null when it is not a long bracket. */
  const longBracket = (): string | null => {
    let p = pos + 1;
    let level = 0;
    while (source[p] === "=") {
      level += 1;
      p += 1;
    }
    if (source[p] !== "[") return null;
    p += 1;
    const startLine = line;
    const startCol = col();
    if (source[p] === "\r" || source[p] === "\n") p += newline(p); // first newline is skipped
    const close = `]${"=".repeat(level)}]`;
    let out = "";
    for (;;) {
      if (p >= source.length) throw new LuaSyntaxError(`unfinished long string/comment (starting at line ${startLine})`, startLine, startCol);
      if (source.startsWith(close, p)) {
        pos = p + close.length;
        return out;
      }
      const c = source[p] ?? "";
      if (c === "\r" || c === "\n") {
        const len = newline(p);
        out += "\n";
        p += len;
      } else {
        out += c;
        p += 1;
      }
    }
  };

  if (source.startsWith("#!")) while (pos < source.length && source[pos] !== "\n") pos += 1;

  while (pos < source.length) {
    const c = source[pos] ?? "";
    if (c === "\n" || c === "\r") {
      pos += newline(pos);
      continue;
    }
    if (c === " " || c === "\t" || c === "\f" || c === "\v") {
      pos += 1;
      continue;
    }

    // comments
    if (c === "-" && source[pos + 1] === "-") {
      pos += 2;
      if (source[pos] === "[" && longBracket() !== null) continue;
      while (pos < source.length && source[pos] !== "\n" && source[pos] !== "\r") pos += 1;
      continue;
    }

    const start = pos;
    const startLine = line;
    const startCol = col();
    const push = (type: TokenType, value = source.slice(start, pos)) =>
      tokens.push({ type, text: source.slice(start, pos), value, line: startLine, column: startCol, start, end: pos });

    if (isNameStart(c)) {
      while (isNameChar(source[pos])) pos += 1;
      const word = source.slice(start, pos);
      push(KEYWORDS.has(word) ? "keyword" : "name");
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(source[pos + 1]))) {
      if (c === "0" && (source[pos + 1] === "x" || source[pos + 1] === "X")) {
        pos += 2;
        let digits = 0;
        while (isHex(source[pos]) || source[pos] === ".") {
          if (source[pos] !== ".") digits += 1;
          pos += 1;
        }
        if (digits === 0) fail("malformed number", start);
        if (source[pos] === "p" || source[pos] === "P") {
          pos += 1;
          if (source[pos] === "+" || source[pos] === "-") pos += 1;
          if (!isDigit(source[pos])) fail("malformed number", start);
          while (isDigit(source[pos])) pos += 1;
        }
      } else {
        while (isDigit(source[pos]) || source[pos] === ".") pos += 1;
        if (source[pos] === "e" || source[pos] === "E") {
          pos += 1;
          if (source[pos] === "+" || source[pos] === "-") pos += 1;
          if (!isDigit(source[pos])) fail("malformed number", start);
          while (isDigit(source[pos])) pos += 1;
        }
      }
      if (isNameChar(source[pos])) fail(`malformed number near '${source.slice(start, pos + 1)}'`, start);
      push("number");
      continue;
    }

    if (c === '"' || c === "'") {
      pos += 1;
      let value = "";
      for (;;) {
        const ch = source[pos];
        if (ch === undefined || ch === "\n" || ch === "\r") throw new LuaSyntaxError(`unfinished string near '${source.slice(start, pos)}'`, startLine, startCol);
        if (ch === c) {
          pos += 1;
          break;
        }
        if (ch === "\\") {
          const esc = source[pos + 1];
          pos += 2;
          if (esc === undefined) throw new LuaSyntaxError("unfinished string", startLine, startCol);
          if ("abfnrtv\\\"'".includes(esc)) {
            value += { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" }[esc] ?? esc;
          } else if (esc === "\n" || esc === "\r") {
            pos -= 1;
            pos += newline(pos);
            value += "\n";
          } else if (esc === "x") {
            if (!isHex(source[pos]) || !isHex(source[pos + 1])) fail("hexadecimal digit expected", pos);
            value += String.fromCharCode(parseInt(source.slice(pos, pos + 2), 16));
            pos += 2;
          } else if (esc === "z") {
            while (/\s/.test(source[pos] ?? "x")) {
              if (source[pos] === "\n" || source[pos] === "\r") pos += newline(pos);
              else pos += 1;
            }
          } else if (isDigit(esc)) {
            let digits = esc;
            while (digits.length < 3 && isDigit(source[pos])) digits += source[pos++];
            const code = Number(digits);
            if (code > 255) fail("decimal escape too large", pos);
            value += String.fromCharCode(code);
          } else if (esc === "u") {
            if (source[pos] !== "{") fail("missing '{' in \\u{xxxx}", pos);
            const end = source.indexOf("}", pos);
            const hex = end > 0 ? source.slice(pos + 1, end) : "";
            if (!/^[0-9a-fA-F]+$/.test(hex)) fail("hexadecimal digit expected", pos);
            value += String.fromCodePoint(parseInt(hex, 16));
            pos = end + 1;
          } else {
            throw new LuaSyntaxError(`invalid escape sequence '\\${esc}'`, line, col(pos - 2));
          }
          continue;
        }
        value += ch;
        pos += 1;
      }
      push("string", value);
      continue;
    }

    if (c === "[") {
      const content = longBracket();
      if (content !== null) {
        push("string", content);
        continue;
      }
    }

    const op = OPERATORS.find((o) => source.startsWith(o, pos));
    if (!op) fail(`unexpected symbol near '${c}'`);
    pos += op?.length ?? 1;
    push("op");
  }

  tokens.push({ type: "eof", text: "<eof>", value: "<eof>", line, column: col(), start: pos, end: pos });
  return tokens;
}
