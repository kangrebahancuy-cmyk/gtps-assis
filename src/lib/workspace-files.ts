/** Naming rules for files added to the Lua workspace (pure, so they can be tested without the store). */

const MAX_BASE = 60;

/** `Daily Reward!.lua` -> `daily_reward.lua`: letters, digits, `_` and `-`, always ending in `.lua`. */
export function sanitizeLuaFileName(wanted: string): string {
  const base = wanted
    .trim()
    .replace(/\.lua$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, MAX_BASE);
  return `${base || "script"}.lua`;
}

/** The sanitized name, made unique among `existing` by appending _2, _3, ... */
export function uniqueFileName(existing: readonly string[], wanted: string): string {
  const name = sanitizeLuaFileName(wanted);
  const taken = new Set(existing.map((n) => n.toLowerCase()));
  if (!taken.has(name)) return name;
  const base = name.replace(/\.lua$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${base}_${n}.lua`;
    if (!taken.has(candidate)) return candidate;
  }
}
