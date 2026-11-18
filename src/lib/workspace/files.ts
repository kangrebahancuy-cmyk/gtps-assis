/** Pure helpers for workspace files: names, importing, exporting. No DOM, so they run in Node tests too. */
import { sanitizeLuaFileName } from "@/lib/workspace-files";

export { sanitizeLuaFileName, uniqueFileName } from "@/lib/workspace-files";

/** Largest file accepted by Import (Lua scripts are small; this stops a wrong file from freezing the editor). */
export const MAX_IMPORT_BYTES = 1024 * 1024;
/** Largest project accepted by "Import project". */
export const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
export const MAX_PROJECT_FILES = 200;

const LUA_NAME = /\.(lua|txt)$/i;

export type ImportOutcome = { ok: true; name: string; text: string } | { ok: false; name: string; error: string };

/**
 * Turns the bytes of a chosen file into editor text. Rejects what is not a text Lua file:
 * wrong extension, too big, contains NUL bytes (binary), or is not valid UTF-8.
 * A UTF-8 BOM is removed and CRLF/CR line endings become LF.
 */
export function readImportedFile(fileName: string, bytes: Uint8Array): ImportOutcome {
  const name = fileName.split(/[\\/]/).pop() ?? fileName;
  if (!LUA_NAME.test(name)) return { ok: false, name, error: `${name}: only .lua (or .txt) files can be imported.` };
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    return { ok: false, name, error: `${name}: too large (${Math.ceil(bytes.byteLength / 1024)} KB; the limit is ${MAX_IMPORT_BYTES / 1024} KB).` };
  }
  if (bytes.includes(0)) return { ok: false, name, error: `${name}: looks like a binary file (it contains NUL bytes), not Lua source.` };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, name, error: `${name}: not valid UTF-8 text.` };
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { ok: true, name, text: normalizeNewlines(text) };
}

export const normalizeNewlines = (text: string): string => text.replace(/\r\n?/g, "\n");

/** A file name that is safe to download as: sanitized and ending in .lua. */
export const downloadFileName = (name: string): string => sanitizeLuaFileName(name);

/** The project file written by "Export project" and read by "Import project". */
export const PROJECT_FORMAT = "gtps-lua-workspace";
export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: 1;
  exportedAt: string;
  files: Array<{ name: string; content: string }>;
}

export function buildProject(files: ReadonlyArray<{ name: string; content: string }>, now = new Date()): string {
  const project: ProjectFile = { format: PROJECT_FORMAT, version: 1, exportedAt: now.toISOString(), files: files.map(({ name, content }) => ({ name, content })) };
  return JSON.stringify(project, null, 2);
}

export type ProjectParse = { ok: true; files: Array<{ name: string; content: string }> } | { ok: false; error: string };

export function parseProject(text: string): ProjectParse {
  if (text.length > MAX_PROJECT_BYTES) return { ok: false, error: "This project file is too large." };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This is not a valid project file (invalid JSON)." };
  }
  if (typeof data !== "object" || data === null || (data as { format?: unknown }).format !== PROJECT_FORMAT) {
    return { ok: false, error: "This is not a GTPS Lua workspace project file." };
  }
  const { version, files } = data as { version?: unknown; files?: unknown };
  if (version !== 1) return { ok: false, error: `Unsupported project version: ${String(version)}.` };
  if (!Array.isArray(files)) return { ok: false, error: "The project file has no file list." };
  if (files.length > MAX_PROJECT_FILES) return { ok: false, error: `Too many files (limit ${MAX_PROJECT_FILES}).` };
  const out: Array<{ name: string; content: string }> = [];
  for (const entry of files) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: "The project file has an invalid entry." };
    const { name, content } = entry as { name?: unknown; content?: unknown };
    if (typeof name !== "string" || typeof content !== "string") return { ok: false, error: "The project file has an entry without a name or content." };
    if (content.length > MAX_IMPORT_BYTES) return { ok: false, error: `${name}: too large to import.` };
    out.push({ name, content: normalizeNewlines(content) });
  }
  return { ok: true, files: out };
}
