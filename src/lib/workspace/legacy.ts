/**
 * Before Step 9 the workspace kept its files in localStorage (key "gtps-assistant:workspace", written by a zustand
 * store). This reads that data so scripts saved there ("Open in Lua Workspace" from the generator) are not lost.
 * The two placeholder files the old workspace shipped with are ignored.
 */
export const LEGACY_STORAGE_KEY = "gtps-assistant:workspace";

const PLACEHOLDERS = new Set(["-- main.lua\n-- Workspace placeholder. Write your Lua here.\n", "-- scratch.lua\n"]);

export function parseLegacyWorkspace(raw: string | null): Array<{ name: string; content: string }> {
  if (!raw) return [];
  try {
    const files = (JSON.parse(raw) as { state?: { files?: unknown } }).state?.files;
    if (!Array.isArray(files)) return [];
    const out: Array<{ name: string; content: string }> = [];
    for (const f of files) {
      const { name, content } = (f ?? {}) as { name?: unknown; content?: unknown };
      if (typeof name === "string" && typeof content === "string" && !PLACEHOLDERS.has(content)) out.push({ name, content });
    }
    return out;
  } catch {
    return [];
  }
}

/** Reads the legacy files from localStorage (empty when there are none or storage is unavailable). */
export function readLegacyWorkspace(): Array<{ name: string; content: string }> {
  try {
    return parseLegacyWorkspace(localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch {
    return [];
  }
}
