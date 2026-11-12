/** A small Lua tokenizer for syntax highlighting. Pure: no DOM, no dependencies. */

export type LuaTokenType = "keyword" | "constant" | "string" | "comment" | "number" | "function" | "builtin" | "plain";

export interface LuaToken {
  type: LuaTokenType;
  text: string;
}

const KEYWORDS = new Set([
  "and", "break", "do", "else", "elseif", "end", "for", "function", "goto", "if", "in", "local", "not", "or",
  "repeat", "return", "then", "until", "while",
]);
const CONSTANTS = new Set(["true", "false", "nil"]);
const BUILTINS = new Set([
  "print", "pairs", "ipairs", "type", "tostring", "tonumber", "table", "string", "math", "os", "io", "require",
  "pcall", "error", "assert", "select", "next", "setmetatable", "getmetatable", "unpack", "self",
]);

/** `[[ ... ]]` / `[==[ ... ]==]` starting at `i`, or -1 when the text there is not a long bracket. */
function longBracketEnd(src: string, i: number): number {
  const open = /^\[(=*)\[/.exec(src.slice(i, i + 40));
  if (!open) return -1;
  const close = `]${open[1] ?? ""}]`;
  const end = src.indexOf(close, i + open[0].length);
  return end === -1 ? src.length : end + close.length;
}

export function tokenizeLua(src: string): LuaToken[] {
  const tokens: LuaToken[] = [];
  const push = (type: LuaTokenType, text: string) => {
    const last = tokens[tokens.length - 1];
    if (last && last.type === type && type === "plain") last.text += text;
    else tokens.push({ type, text });
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i] ?? "";
    const rest = src.slice(i);

    if (rest.startsWith("--")) {
      const long = longBracketEnd(src, i + 2);
      const end = long !== -1 ? long : (src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i));
      push("comment", src.slice(i, end));
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== "\n") j += src[j] === "\\" ? 2 : 1;
      const end = src[j] === ch ? j + 1 : Math.min(j, src.length);
      push("string", src.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "[") {
      const end = longBracketEnd(src, i);
      if (end !== -1) {
        push("string", src.slice(i, end));
        i = end;
        continue;
      }
    }
    const number = /^(?:0[xX][\da-fA-F]+(?:\.[\da-fA-F]*)?(?:[pP][+-]?\d+)?|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(rest);
    if (number && !/[\w]/.test(src[i - 1] ?? "")) {
      push("number", number[0]);
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_]\w*/.exec(rest);
    if (word) {
      const text = word[0];
      const after = src.slice(i + text.length).match(/^\s*[(]/);
      const previous = src[i - 1];
      const member = previous === "." || previous === ":";
      if (KEYWORDS.has(text) && !member) push("keyword", text);
      else if (CONSTANTS.has(text) && !member) push("constant", text);
      else if (after || (member && src.slice(i + text.length).startsWith("(") )) push("function", text);
      else if (BUILTINS.has(text) && !member) push("builtin", text);
      else push("plain", text);
      i += text.length;
      continue;
    }
    push("plain", ch);
    i += 1;
  }
  return tokens;
}

/** True for the language labels we highlight as Lua. */
export const isLua = (language: string | null | undefined): boolean => /^(lua|luau)$/i.test(language ?? "");
