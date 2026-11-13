/** The few node:assert functions the shared test code uses, for the browser bundle. */
function fail(message: string): never {
  throw new Error(message);
}
function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
const show = (v: unknown) => JSON.stringify(v);
const assert = {
  ok: (v: unknown, m?: string) => void (v || fail(m ?? `expected truthy, got ${show(v)}`)),
  equal: (a: unknown, b: unknown, m?: string) => void (Object.is(a, b) || fail(m ?? `expected ${show(b)}, got ${show(a)}`)),
  notEqual: (a: unknown, b: unknown, m?: string) => void (!Object.is(a, b) || fail(m ?? `expected not ${show(b)}`)),
  deepEqual: (a: unknown, b: unknown, m?: string) => void (same(a, b) || fail(m ?? `expected ${show(b)}, got ${show(a)}`)),
  match: (s: string, re: RegExp, m?: string) => void (re.test(s) || fail(m ?? `${show(s)} does not match ${re}`)),
  doesNotMatch: (s: string, re: RegExp, m?: string) => void (!re.test(s) || fail(m ?? `${show(s)} matches ${re}`)),
  throws: (fn: () => unknown) => {
    try {
      fn();
    } catch {
      return;
    }
    fail("expected a throw");
  },
  rejects: async (p: Promise<unknown> | (() => Promise<unknown>)) => {
    try {
      await (typeof p === "function" ? p() : p);
    } catch {
      return;
    }
    fail("expected a rejection");
  },
};
export default assert;
