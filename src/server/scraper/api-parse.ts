/** Pure helpers for API/code parsing. No HTML parser dependency. */

const SIGNATURE_PATTERN =
  /^([A-Za-z_][\w]*(?:[:.][A-Za-z_][\w]*)?)\s*\(([^()]*)\)\s*$/;

/** Callback registration: `onSomethingCallback(function(a, b, c)`. */
const CALLBACK_PATTERN =
  /^([A-Za-z_][\w]*)\s*\(\s*function\s*\(([^()]*)\)\s*$/;

function splitParams(raw: string): string[] {
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Guesses Lua for untagged blocks that look like Lua. */
export function detectLanguage(code: string, declared: string | null): string | null {
  if (declared) return declared;
  if (
    /\b(function|local|end|then|elseif|nil)\b/.test(code) ||
    /\bCallback\s*\(/.test(code) ||
    /\w+:\w+\(/.test(code) ||
    /--\s/.test(code)
  ) {
    return "lua";
  }
  return null;
}

export function parseSignature(
  text: string,
): { name: string; params: string[] } | null {
  const line = oneLine(text);
  const match = SIGNATURE_PATTERN.exec(line) ?? CALLBACK_PATTERN.exec(line);
  if (!match) return null;
  return { name: match[1] ?? "", params: splitParams(match[2] ?? "") };
}

export function readEntryDetails(
  lines: readonly string[],
  signature: string,
): { description: string | null; returns: string | null } {
  let returns: string | null = null;
  let description: string | null = null;
  for (const line of lines) {
    const ret = /^Returns?\s*[:\-]?\s*(\S.*)$/i.exec(line);
    if (ret && returns === null) {
      returns = ret[1] ?? null;
      continue;
    }
    if (/^(Parameters?|Returns?)\s*:?$/i.test(line)) continue;
    if (line === signature || parseSignature(line)) continue;
    if (description === null) description = line;
  }
  return { description, returns };
}

