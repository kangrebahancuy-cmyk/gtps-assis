import type { Db } from "@/server/db/database";
import { parseLua, type CallSite, type FunctionDef, type LuaParse, type Unit } from "@/lib/lua/parser";
import { LUA_GLOBAL_FUNCTIONS, LUA_LIBRARIES, STRING_METHODS, isRestrictedLua } from "@/lib/lua/stdlib";
import { classifyApiEntry, splitApiName } from "@/server/docs/classify";
import type { ApiUse, ApiUseStatus, Finding, FindingKind, FindingSeverity, Preservation, ScriptCheck } from "@/types/lua";

/**
 * Checks a generated (or user-supplied) script against the indexed documentation. Everything is a
 * lookup or a parse: a name is "documented" only if an api_entries row has it, and a script "passes"
 * only if it parses and has no error-level finding. Nothing is guessed.
 */

interface Entry {
  name: string;
  owner: string | null;
  member: string;
  signature: string;
  params: string[];
  kind: "function" | "method" | "callback" | "event";
  documentId: number;
  title: string;
  url: string;
}

const MAX_FINDINGS = 60;
const PLACEHOLDER = /--+\s*(\.{3}|…|\(?\s*(rest|remaining|remainder|existing|unchanged|same as before|previous|other) (of )?(the )?(code|script|functions?|logic)|\[?(your|insert) code here)/i;

function parseParams(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.map((p) => (typeof p === "string" ? p : typeof p === "object" && p !== null && "name" in p ? String((p as { name: unknown }).name) : "")).filter(Boolean);
  } catch {
    return [];
  }
}

function loadEntries(db: Db): Entry[] {
  const rows = db
    .prepare(
      `SELECT a.name, a.signature, a.params_json, a.kind, d.id AS document_id, d.title, d.url
         FROM api_entries a JOIN documents d ON d.id = a.document_id AND d.deleted_at IS NULL`,
    )
    .all() as Array<{ name: string; signature: string; params_json: string; kind: string | null; document_id: number; title: string; url: string }>;
  return rows.map((r) => {
    const { owner, member } = splitApiName(r.name);
    return {
      name: r.name, owner, member, signature: r.signature, params: parseParams(r.params_json),
      kind: (r.kind as Entry["kind"] | null) ?? classifyApiEntry(r.name), documentId: r.document_id, title: r.title, url: r.url,
    };
  });
}

class Catalog {
  private readonly byName = new Map<string, Entry[]>();
  private readonly byMember = new Map<string, Entry[]>();
  private readonly byLower = new Map<string, Entry[]>();
  private readonly byMemberLower = new Map<string, Entry[]>();

  constructor(entries: Entry[]) {
    const add = (map: Map<string, Entry[]>, key: string, e: Entry) => {
      const list = map.get(key);
      if (list) list.push(e);
      else map.set(key, [e]);
    };
    for (const e of entries) {
      add(this.byName, e.name, e);
      add(this.byMember, e.member, e);
      add(this.byLower, e.name.toLowerCase(), e);
      add(this.byMemberLower, e.member.toLowerCase(), e);
    }
  }

  /** Exact (case-sensitive) lookup; `Owner.member` and `Owner:member` count as the same entry. */
  full(name: string): Entry[] {
    const direct = this.byName.get(name);
    if (direct) return direct;
    const { owner, member } = splitApiName(name);
    if (owner === null) return [];
    return (this.byMember.get(member) ?? []).filter((e) => e.owner === owner);
  }

  /** Entries with this member name on any owner. */
  member(member: string): Entry[] {
    return this.byMember.get(member) ?? [];
  }

  /** A differently-cased documented name, for "did you mean". */
  suggest(name: string): string | null {
    const lower = name.toLowerCase();
    const hit = this.byLower.get(lower)?.[0] ?? this.byMemberLower.get((splitApiName(name).member).toLowerCase())?.[0];
    return hit && hit.name !== name ? hit.name : null;
  }
}

function isOptional(param: string, signature: string): boolean {
  if (/\?$|^\[|optional|=/i.test(param)) return true;
  const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\[[^\\]]*\\b${escaped}\\b`).test(signature);
}

function arityBounds(entry: Entry): { min: number; max: number } {
  if (entry.params.some((p) => p === "..." || p.startsWith("..."))) return { min: entry.params.filter((p) => !p.startsWith("...") && !isOptional(p, entry.signature)).length, max: Infinity };
  return { min: entry.params.filter((p) => !isOptional(p, entry.signature)).length, max: entry.params.length };
}

const EVENT_NAME = /^on[A-Z][A-Za-z0-9_]*$/;

export interface VerifyOptions {
  /** The script before the change (modification workflow). */
  original?: string | null;
}

export function verifyScript(db: Db, code: string, options: VerifyOptions = {}): ScriptCheck {
  const findings: Finding[] = [];
  const add = (kind: FindingKind, severity: FindingSeverity, message: string, line: number | null, name: string | null = null) => {
    if (findings.length < MAX_FINDINGS) findings.push({ kind, severity, message, line, name });
  };

  const parsed = parseLua(code);
  if (!parsed.ok) {
    add("syntax", "error", `Syntax error at line ${parsed.error.line}, column ${parsed.error.column}: ${parsed.error.message}`, parsed.error.line);
    return {
      syntax: { ok: false, ...parsed.error },
      stats: { lines: code.split(/\r\n|\n|\r/).length, functions: 0, calls: 0, units: 0 },
      apiUses: [],
      findings,
      preservation: null,
      passed: false,
    };
  }

  checkPlaceholders(code, add);
  if (parsed.units.length === 0) add("incomplete", "error", "The script has no statements.", null);

  const catalog = new Catalog(loadEntries(db));
  const apiUses = checkApis(parsed, catalog, add);

  const preservation = options.original ? comparePreservation(options.original, parsed.units, add) : null;

  return {
    syntax: { ok: true },
    stats: { lines: parsed.lines, functions: parsed.functions.length, calls: parsed.calls.length, units: parsed.units.length },
    apiUses,
    findings,
    preservation,
    passed: !findings.some((f) => f.severity === "error"),
  };
}

type Add = (kind: FindingKind, severity: FindingSeverity, message: string, line: number | null, name?: string | null) => void;

function checkPlaceholders(code: string, add: Add): void {
  code.split(/\r\n|\n|\r/).forEach((text, index) => {
    if (PLACEHOLDER.test(text)) add("incomplete", "error", `Line ${index + 1} is a placeholder comment ("${text.trim().slice(0, 60)}"): the script must be complete, not abbreviated.`, index + 1);
  });
}

function checkApis(parsed: LuaParse, catalog: Catalog, add: Add): ApiUse[] {
  const uses = new Map<string, ApiUse>();
  const scriptNames = new Set<string>([...parsed.functions.map((f) => f.name ?? ""), ...parsed.globalsAssigned]);
  const scriptMembers = new Set<string>([...parsed.memberFunctions, ...parsed.functions.map((f) => f.chain[f.chain.length - 1] ?? "")]);

  const record = (name: string, status: ApiUseStatus, line: number, extra: Partial<ApiUse> = {}) => {
    const key = `${status}|${name}`;
    const existing = uses.get(key);
    if (existing) {
      if (!existing.lines.includes(line)) existing.lines.push(line);
      return;
    }
    uses.set(key, {
      name, status, documentedAs: null, signature: null, kind: null, source: null, lines: [line], suggestion: null, ...extra,
    });
  };
  const documented = (name: string, line: number, entries: Entry[]) => {
    const e = entries[0] as Entry;
    record(name, "documented", line, {
      documentedAs: e.name, signature: e.signature, kind: e.kind, source: { documentId: e.documentId, title: e.title, url: e.url },
    });
  };

  for (const call of parsed.calls) {
    checkCall(call, catalog, { scriptNames, scriptMembers, locals: new Set(parsed.locals), record, documented, add });
    checkEventStrings(call, catalog, { record, documented, add });
  }
  for (const fn of parsed.functions) checkHandlerDefinition(fn, catalog, { record, documented, add });

  return [...uses.values()].sort((a, b) => a.lines[0]! - b.lines[0]!);
}

interface Ctx {
  scriptNames: Set<string>;
  scriptMembers: Set<string>;
  locals: Set<string>;
  record: (name: string, status: ApiUseStatus, line: number, extra?: Partial<ApiUse>) => void;
  documented: (name: string, line: number, entries: Entry[]) => void;
  add: Add;
}

function displayName(call: CallSite): string {
  if (call.chain[0] === "?") return `<value>${call.method ? ":" : "."}${call.chain[call.chain.length - 1]}`;
  return call.text;
}

function checkCall(call: CallSite, catalog: Catalog, ctx: Ctx): void {
  if (call.dynamic) return;
  const { add, record } = ctx;
  const name = displayName(call);
  const member = call.chain[call.chain.length - 1] as string;
  const root = call.chain[0] as string;
  const line = call.line;

  // A global function the script defines itself, or a local function / parameter being called.
  if (call.chain.length === 1) {
    if (call.root === "local") return;
    if (ctx.scriptNames.has(root)) return;
    const entries = catalog.full(root);
    if (entries.length) return verifyDocumented(call, name, entries, ctx);
    if (LUA_GLOBAL_FUNCTIONS.has(root)) {
      record(name, "lua_standard", line);
      if (isRestrictedLua(root)) add("restricted_lua", "warning", `${root}() is standard Lua, not a GTPS API, and servers often block it. The documentation does not list it.`, line, root);
      return;
    }
    return undocumented(call, name, catalog, ctx);
  }

  // Library call: string.format, table.insert, os.time, ...
  const lib = LUA_LIBRARIES[root];
  if (lib && call.root === "global" && !ctx.locals.has(root) && !ctx.scriptNames.has(root)) {
    const entries = catalog.full(name);
    if (entries.length) return verifyDocumented(call, name, entries, ctx);
    if (!lib.has(member)) {
      add("lua_standard", "error", `${name} does not exist in standard Lua and is not in the GTPS documentation.`, line, name);
      record(name, "undocumented", line, { suggestion: catalog.suggest(name) });
      return;
    }
    record(name, "lua_standard", line);
    if (isRestrictedLua(`${root}.${member}`)) add("restricted_lua", "warning", `${root}.${member} is standard Lua, not a GTPS API, and servers often block it. The documentation does not list it.`, line, name);
    return;
  }

  // Defined by the script: `Shop:buy`, `M.helper`, or a function stored in a table constructor.
  if (ctx.scriptNames.has(call.chain.join(".")) || ctx.scriptNames.has(call.text) || (call.root !== "global" || ctx.locals.has(root) || ctx.scriptNames.has(root)) && ctx.scriptMembers.has(member)) {
    if (!catalog.full(name).length && !catalog.member(member).length) return;
  }

  // Global library of the game (`timer.setInterval`): the whole name must be documented.
  if (call.root === "global" && !ctx.locals.has(root) && !ctx.scriptNames.has(root)) {
    const entries = catalog.full(call.chain.join("."));
    if (entries.length) return verifyDocumented(call, name, entries, ctx);
    return undocumented(call, name, catalog, ctx);
  }

  // A value of unknown type (parameter, local, call result): only the member name can be checked.
  const entries = catalog.member(member);
  if (entries.length) return verifyDocumented(call, name, entries, ctx);
  if (call.method && STRING_METHODS.has(member)) {
    record(name, "lua_standard", line);
    return;
  }
  if (ctx.scriptMembers.has(member)) return;
  if (call.method) return undocumented(call, name, catalog, ctx);
  record(name, "unresolved", line);
  add("unverified_call", "warning", `${name}() could not be verified: it is not in the documentation and the script does not define it.`, line, name);
}

function undocumented(call: CallSite, name: string, catalog: Catalog, ctx: Ctx): void {
  const suggestion = catalog.suggest(call.chain.join("."));
  ctx.record(name, "undocumented", call.line, { suggestion });
  ctx.add(
    "undocumented_api",
    "error",
    `${name} is not in the indexed GTPS documentation.${suggestion ? ` Did you mean ${suggestion}?` : ""} It may not exist, so it must not be relied on.`,
    call.line,
    name,
  );
}

function verifyDocumented(call: CallSite, name: string, entries: Entry[], ctx: Ctx): void {
  ctx.documented(name, call.line, entries);
  const first = entries[0] as Entry;
  if (first.kind === "callback" || first.kind === "event") return verifyRegistration(call, name, entries, ctx);

  const ok = entries.some((e) => {
    let argc = call.argc;
    if (!call.method && e.name.includes(":") && call.chain.length > 1) argc -= 1; // Owner.method(self, ...) form
    if (call.method && e.name.includes(".") && !e.name.includes(":")) argc += 1;
    const { min, max } = arityBounds(e);
    return (call.variadicTail || argc >= min) && argc <= max;
  });
  if (ok) return;
  let argc = call.argc;
  if (!call.method && first.name.includes(":") && call.chain.length > 1) argc -= 1;
  const { min, max } = arityBounds(first);
  const list = first.params.length ? ` (${first.params.join(", ")})` : "";
  const wanted = min === max ? `${max}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
  ctx.add("wrong_arguments", "error", `${name} is documented as ${first.signature} and takes ${wanted} argument${max === 1 && min === 1 ? "" : "s"}${list}, but it is called with ${argc}.`, call.line, name);
}

/** `onPlayerChatCallback(function(world, player, message) ... end)`: the documented params describe the callback. */
function verifyRegistration(call: CallSite, name: string, entries: Entry[], ctx: Ctx): void {
  const e = entries[0] as Entry;
  if (call.argc === 0) {
    ctx.add("wrong_arguments", "error", `${name} registers a handler and needs a function argument (${e.signature}).`, call.line, name);
    return;
  }
  for (const fn of call.functionArgs) compareHandlerParams(name, e, fn.params, fn.vararg, call.line, ctx.add);
}

function compareHandlerParams(name: string, e: Entry, declared: string[], vararg: boolean, line: number, add: Add): void {
  if (vararg) return;
  if (declared.length > e.params.length) {
    add("callback_signature", "warning", `${name} passes ${e.params.length} value${e.params.length === 1 ? "" : "s"} (${e.params.join(", ") || "none"}) but the handler declares ${declared.length} parameters (${declared.join(", ")}); the extra ones will always be nil.`, line, name);
  } else if (declared.length < e.params.length) {
    add("callback_signature", "info", `${name} passes ${e.params.length} values (${e.params.join(", ")}); the handler only declares ${declared.length}, so the rest are ignored.`, line, name);
  }
}

/** A string that looks like an event name must be a documented event or callback. */
function checkEventStrings(call: CallSite, catalog: Catalog, ctx: Pick<Ctx, "record" | "documented" | "add">): void {
  for (const s of call.stringArgs) {
    if (s === null || !EVENT_NAME.test(s)) continue;
    const entries = catalog.full(s).filter((e) => e.kind === "event" || e.kind === "callback");
    if (entries.length) {
      ctx.documented(s, call.line, entries);
      continue;
    }
    const suggestion = catalog.suggest(s);
    ctx.record(s, "undocumented", call.line, { suggestion });
    ctx.add("unknown_event", "error", `"${s}" is not a documented event or callback name.${suggestion ? ` Did you mean ${suggestion}?` : ""}`, call.line, s);
  }
}

/** `function onPlayerJoin(world, player)` defines a handler: its name and parameters must match the documentation. */
function checkHandlerDefinition(fn: FunctionDef, catalog: Catalog, ctx: Pick<Ctx, "record" | "documented" | "add">): void {
  if (fn.chain.length !== 1 || fn.local) return;
  const name = fn.chain[0] as string;
  const entries = catalog.full(name).filter((e) => e.kind === "event" || e.kind === "callback");
  if (entries.length) {
    ctx.documented(name, fn.line, entries);
    compareHandlerParams(name, entries[0] as Entry, fn.params, fn.vararg, fn.line, ctx.add);
    return;
  }
  if (EVENT_NAME.test(name) && !catalog.full(name).length) {
    const suggestion = catalog.suggest(name);
    ctx.record(name, "undocumented", fn.line, { suggestion });
    ctx.add("unknown_event", "error", `${name} looks like an event handler but no event or callback with this name is documented.${suggestion ? ` Did you mean ${suggestion}?` : ""} The server will never call it.`, fn.line, name);
  }
}

// ---- preservation (modification workflow) ------------------------------------------------------

function unitLabel(u: Unit): string {
  return u.kind === "function" ? `function ${u.name}` : u.kind === "control" || u.kind === "return" || u.kind === "other" ? `${u.name} block (line ${u.line})` : `${u.kind} ${u.name}`;
}

function keyed(units: Unit[]): Map<string, Unit> {
  const seen = new Map<string, number>();
  const out = new Map<string, Unit>();
  for (const u of units) {
    const base = `${u.kind}:${u.name}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.set(`${base}#${n}`, u);
  }
  return out;
}

function comparePreservation(original: string, now: Unit[], add: Add): Preservation | null {
  const before = parseLua(original);
  if (!before.ok) {
    add("preservation_skipped", "info", `The original script has a syntax error (line ${before.error.line}: ${before.error.message}), so unrelated functionality could not be compared.`, null);
    return null;
  }
  const a = keyed(before.units);
  const b = keyed(now);
  const result: Preservation = { preserved: [], modified: [], removed: [], added: [] };
  for (const [key, u] of a) {
    const other = b.get(key);
    if (!other) {
      result.removed.push(unitLabel(u));
      add("removed_feature", "warning", `${unitLabel(u)} (original lines ${u.line}-${u.endLine}) is missing from the new script. Unrelated functionality should be preserved.`, null, u.name);
    } else if (other.fingerprint === u.fingerprint) result.preserved.push(unitLabel(u));
    else {
      result.modified.push(unitLabel(u));
      add("changed_feature", "info", `${unitLabel(u)} was changed.`, other.line, u.name);
    }
  }
  for (const [key, u] of b) if (!a.has(key)) result.added.push(unitLabel(u));
  return result;
}
