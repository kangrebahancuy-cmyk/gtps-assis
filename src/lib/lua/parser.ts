import { LuaSyntaxError, tokenize, type Token } from "./lexer";

/**
 * A recursive-descent syntax checker for Lua 5.1-5.4 (a superset: `goto`, `//`, bitwise operators
 * and `<const>`/`<close>` are accepted). It reports the first syntax error with line and column,
 * worded like the reference compiler, and extracts what the verifier needs: every call site,
 * every function the script defines, and its top-level units.
 */

export interface CallSite {
  /** Path of the callee: `player:getName` -> ["player", "getName"]. */
  chain: string[];
  /** The callee as written, e.g. "player:getName" or "AddHook". */
  text: string;
  /** Called with `:`. */
  method: boolean;
  /** What the chain starts with: a global name, a local variable/parameter, a call result, or something else. */
  root: "global" | "local" | "call" | "other";
  /** The chain contains a computed key (`a[i]`), so it cannot be resolved statically. */
  dynamic: boolean;
  /** Number of arguments written (`argc` counts the self argument of `:` calls as 0). */
  argc: number;
  /** The last argument is a call or `...`, so it may supply any number of values. */
  variadicTail: boolean;
  /** Literal string arguments by position (null when the argument is not a literal string). */
  stringArgs: (string | null)[];
  /** Function-expression arguments by position. */
  functionArgs: { index: number; params: string[]; vararg: boolean }[];
  line: number;
  column: number;
}

export interface FunctionDef {
  /** `Foo`, `Foo.bar`, `Foo:bar`, or null for anonymous functions. */
  name: string | null;
  chain: string[];
  method: boolean;
  local: boolean;
  params: string[];
  vararg: boolean;
  line: number;
  endLine: number;
}

export type UnitKind = "function" | "call" | "assignment" | "local" | "control" | "return" | "other";

export interface Unit {
  kind: UnitKind;
  /** A stable label: the function name, the call (with its first string argument), the assigned names, or the keyword. */
  name: string;
  line: number;
  endLine: number;
  /** Comment-free, whitespace-free text of the unit: equal fingerprints mean unchanged code. */
  fingerprint: string;
}

export interface LuaParse {
  calls: CallSite[];
  functions: FunctionDef[];
  units: Unit[];
  /** Global variables the script assigns to (not locals). */
  globalsAssigned: string[];
  /** Local names declared anywhere in the script. */
  locals: string[];
  /** Keys of table constructors whose value is a function (`{ greet = function() end }`). */
  memberFunctions: string[];
  /** Total lines of the source. */
  lines: number;
}

export type LuaParseResult =
  | ({ ok: true } & LuaParse)
  | { ok: false; error: { message: string; line: number; column: number } };

interface Prefix {
  kind: "name" | "index" | "call" | "paren";
  chain: string[];
  dynamic: boolean;
  root: CallSite["root"];
}

interface ExprInfo {
  multi: boolean;
  str: string | null;
  fn: { params: string[]; vararg: boolean } | null;
  prefix: Prefix | null;
}

const MAX_DEPTH = 190;
const BLOCK_END = new Set(["else", "elseif", "end", "until"]);
const NO_EXPR: ExprInfo = { multi: false, str: null, fn: null, prefix: null };

/** [left, right] priorities as in lparser.c; unary priority is 12. */
const BINARY: Record<string, [number, number]> = {
  or: [1, 1], and: [2, 2],
  "<": [3, 3], ">": [3, 3], "<=": [3, 3], ">=": [3, 3], "~=": [3, 3], "==": [3, 3],
  "|": [4, 4], "~": [5, 5], "&": [6, 6], "<<": [7, 7], ">>": [7, 7],
  "..": [9, 8], "+": [10, 10], "-": [10, 10],
  "*": [11, 11], "/": [11, 11], "//": [11, 11], "%": [11, 11],
  "^": [14, 13],
};
const UNARY_PRIORITY = 12;

class Parser {
  private i = 0;
  private depth = 0;
  private readonly scopes: string[][] = [];
  private readonly fnStack: { vararg: boolean; loops: number }[] = [{ vararg: true, loops: 0 }];
  readonly calls: CallSite[] = [];
  readonly functions: FunctionDef[] = [];
  readonly units: Unit[] = [];
  readonly globalsAssigned = new Set<string>();
  readonly locals = new Set<string>();
  readonly memberFunctions = new Set<string>();

  constructor(private readonly tokens: Token[]) {}

  // ---- token helpers -------------------------------------------------------------------------
  private get tok(): Token {
    return this.tokens[this.i] as Token;
  }
  private peekAt(n: number): Token {
    return (this.tokens[Math.min(this.i + n, this.tokens.length - 1)]) as Token;
  }
  private next(): Token {
    const t = this.tok;
    if (t.type !== "eof") this.i += 1;
    return t;
  }
  private is(text: string): boolean {
    const t = this.tok;
    return (t.type === "op" || t.type === "keyword") && t.text === text;
  }
  private accept(text: string): boolean {
    if (!this.is(text)) return false;
    this.next();
    return true;
  }
  private fail(message: string, at: Token = this.tok): never {
    const near = at.type === "eof" ? "<eof>" : at.text;
    throw new LuaSyntaxError(`${message} near ${at.type === "eof" ? near : `'${near}'`}`, at.line, at.column);
  }
  private expect(text: string): Token {
    if (!this.is(text)) this.fail(`'${text}' expected`);
    return this.next();
  }
  private expectMatch(what: string, who: string, line: number): void {
    if (this.accept(what)) return;
    if (line === this.tok.line) this.fail(`'${what}' expected`);
    this.fail(`'${what}' expected (to close '${who}' at line ${line})`);
  }
  private name(): string {
    if (this.tok.type !== "name") this.fail("<name> expected");
    return this.next().text;
  }

  // ---- scopes --------------------------------------------------------------------------------
  private open(): void {
    this.scopes.push([]);
  }
  private close(): void {
    this.scopes.pop();
  }
  private declare(name: string): void {
    this.locals.add(name);
    this.scopes[this.scopes.length - 1]?.push(name);
  }
  private isLocal(name: string): boolean {
    return this.scopes.some((s) => s.includes(name));
  }
  private enter(): void {
    this.depth += 1;
    if (this.depth > MAX_DEPTH) this.fail("chunk has too many syntax levels");
  }
  private leave(): void {
    this.depth -= 1;
  }
  private get fn() {
    return this.fnStack[this.fnStack.length - 1] as { vararg: boolean; loops: number };
  }

  // ---- program -------------------------------------------------------------------------------
  parseChunk(): void {
    this.open();
    this.block(true);
    if (this.tok.type !== "eof") this.fail("'<eof>' expected");
    this.close();
  }

  private blockFollow(): boolean {
    return this.tok.type === "eof" || (this.tok.type === "keyword" && BLOCK_END.has(this.tok.text));
  }

  private block(top = false): void {
    this.enter();
    while (!this.blockFollow()) {
      const startIndex = this.i;
      const isReturn = this.is("return");
      const unit = this.statement();
      if (top && unit) this.addUnit(unit, startIndex);
      if (isReturn) break; // `return` must be the last statement of a block
    }
    this.leave();
  }

  private addUnit(u: { kind: UnitKind; name: string }, startIndex: number): void {
    const first = this.tokens[startIndex] as Token;
    const last = this.tokens[Math.max(startIndex, this.i - 1)] as Token;
    const text = this.tokens.slice(startIndex, this.i).map((t) => (t.type === "string" ? JSON.stringify(t.value) : t.text)).join(" ");
    this.units.push({ kind: u.kind, name: u.name, line: first.line, endLine: this.endLineOf(last), fingerprint: text });
  }
  private endLineOf(t: Token): number {
    // a long string can end on a later line than it starts
    const newlines = t.type === "string" && t.text.startsWith("[") ? (t.text.match(/\r\n|\n|\r/g)?.length ?? 0) : 0;
    return t.line + newlines;
  }

  // ---- statements ----------------------------------------------------------------------------
  private statement(): { kind: UnitKind; name: string } | null {
    const t = this.tok;
    const line = t.line;
    if (t.type === "op" && t.text === ";") {
      this.next();
      return null;
    }
    if (t.type === "op" && t.text === "::") {
      this.next();
      const label = this.name();
      this.expect("::");
      return { kind: "other", name: `::${label}::` };
    }
    if (t.type === "keyword") {
      switch (t.text) {
        case "if": return this.ifStat(line);
        case "while": return this.whileStat(line);
        case "do": {
          this.next();
          this.open();
          this.block();
          this.close();
          this.expectMatch("end", "do", line);
          return { kind: "control", name: "do" };
        }
        case "for": return this.forStat(line);
        case "repeat": return this.repeatStat(line);
        case "function": return this.funcStat(line);
        case "local": {
          this.next();
          return this.accept("function") ? this.localFunc(line) : this.localStat();
        }
        case "return": return this.returnStat();
        case "break": {
          this.next();
          if (this.fn.loops === 0) this.fail("break outside a loop at line " + line, t);
          return { kind: "control", name: "break" };
        }
        case "goto": {
          this.next();
          this.name();
          return { kind: "control", name: "goto" };
        }
        default:
      }
    }
    return this.exprStat();
  }

  private ifStat(line: number): { kind: UnitKind; name: string } {
    this.next();
    this.expr();
    this.expect("then");
    this.open();
    this.block();
    this.close();
    for (;;) {
      if (this.is("elseif")) {
        this.next();
        this.expr();
        this.expect("then");
        this.open();
        this.block();
        this.close();
      } else if (this.is("else")) {
        this.next();
        this.open();
        this.block();
        this.close();
        break;
      } else break;
    }
    this.expectMatch("end", "if", line);
    return { kind: "control", name: "if" };
  }

  private whileStat(line: number): { kind: UnitKind; name: string } {
    this.next();
    this.expr();
    this.expect("do");
    this.fn.loops += 1;
    this.open();
    this.block();
    this.close();
    this.fn.loops -= 1;
    this.expectMatch("end", "while", line);
    return { kind: "control", name: "while" };
  }

  private repeatStat(line: number): { kind: UnitKind; name: string } {
    this.next();
    this.fn.loops += 1;
    this.open();
    this.block();
    this.expectMatch("until", "repeat", line);
    this.expr(); // the condition sees the block's locals
    this.close();
    this.fn.loops -= 1;
    return { kind: "control", name: "repeat" };
  }

  private forStat(line: number): { kind: UnitKind; name: string } {
    this.next();
    const first = this.name();
    this.open();
    if (this.is("=")) {
      this.next();
      this.expr();
      this.expect(",");
      this.expr();
      if (this.accept(",")) this.expr();
      this.declare(first);
    } else if (this.is(",") || this.is("in")) {
      const names = [first];
      while (this.accept(",")) names.push(this.name());
      this.expect("in");
      this.exprList();
      for (const n of names) this.declare(n);
    } else {
      this.fail("'=' or 'in' expected");
    }
    this.expect("do");
    this.fn.loops += 1;
    this.open();
    this.block();
    this.close();
    this.fn.loops -= 1;
    this.close();
    this.expectMatch("end", "for", line);
    return { kind: "control", name: "for" };
  }

  private funcStat(line: number): { kind: UnitKind; name: string } {
    this.next();
    const chain = [this.name()];
    let method = false;
    while (this.is(".")) {
      this.next();
      chain.push(this.name());
    }
    if (this.is(":")) {
      this.next();
      chain.push(this.name());
      method = true;
    }
    const root = chain[0] as string;
    if (chain.length === 1 && !this.isLocal(root)) this.globalsAssigned.add(root);
    const body = this.funcBody(method, line);
    const text = method ? `${chain.slice(0, -1).join(".")}:${chain[chain.length - 1]}` : chain.join(".");
    this.functions.push({ name: text, chain, method, local: false, params: body.params, vararg: body.vararg, line, endLine: body.endLine });
    return { kind: "function", name: text };
  }

  private localFunc(line: number): { kind: UnitKind; name: string } {
    const name = this.name();
    this.declare(name); // visible inside its own body (recursion)
    const body = this.funcBody(false, line);
    this.functions.push({ name, chain: [name], method: false, local: true, params: body.params, vararg: body.vararg, line, endLine: body.endLine });
    return { kind: "function", name };
  }

  private localStat(): { kind: UnitKind; name: string } {
    const names: string[] = [];
    do {
      names.push(this.name());
      if (this.is("<")) {
        this.next();
        const attrib = this.name();
        if (attrib !== "const" && attrib !== "close") this.fail(`unknown attribute '${attrib}'`);
        this.expect(">");
      }
    } while (this.accept(","));
    let fn: ExprInfo["fn"] = null;
    if (this.accept("=")) {
      const list = this.exprList();
      fn = list.infos.length === 1 ? (list.infos[0] as ExprInfo).fn : null;
    }
    for (const n of names) this.declare(n);
    if (fn && names.length === 1) {
      const line = this.tokens[this.i - 1]?.line ?? 1;
      this.functions.push({ name: names[0] as string, chain: names as string[], method: false, local: true, params: fn.params, vararg: fn.vararg, line, endLine: line });
    }
    return { kind: "local", name: names.join(",") };
  }

  private returnStat(): { kind: UnitKind; name: string } {
    this.next();
    if (!this.blockFollow() && !this.is(";")) this.exprList();
    this.accept(";");
    return { kind: "return", name: "return" };
  }

  private exprStat(): { kind: UnitKind; name: string } {
    const startTok = this.tok;
    const first = this.suffixedExpr();
    if (this.is("=") || this.is(",")) {
      const targets = [first];
      while (this.accept(",")) targets.push(this.suffixedExpr());
      for (const t of targets) {
        if (!t.prefix || (t.prefix.kind !== "name" && t.prefix.kind !== "index")) this.fail("syntax error", startTok);
      }
      this.expect("=");
      const list = this.exprList();
      const labels: string[] = [];
      targets.forEach((t, idx) => {
        const p = t.prefix as Prefix;
        const label = p.dynamic ? "[]" : p.chain.join(".");
        labels.push(label);
        if (p.kind === "name" && p.root === "global") this.globalsAssigned.add(p.chain[0] as string);
        const value = list.infos[idx];
        if (value?.fn && !p.dynamic) {
          const line = startTok.line;
          this.functions.push({ name: label, chain: p.chain, method: false, local: p.root === "local", params: value.fn.params, vararg: value.fn.vararg, line, endLine: this.tokens[this.i - 1]?.line ?? line });
        }
      });
      return { kind: "assignment", name: labels.join(",") };
    }
    if (!first.prefix || first.prefix.kind !== "call") this.fail("syntax error", this.tok);
    // Calls are recorded when their arguments are done, so the last one is this statement's outermost call.
    const target = this.calls[this.calls.length - 1];
    const label = target ? `${target.text}${target.stringArgs[0] ? `(${JSON.stringify(target.stringArgs[0])})` : ""}` : "call";
    return { kind: "call", name: label };
  }

  // ---- expressions ---------------------------------------------------------------------------
  private exprList(): { infos: ExprInfo[] } {
    const infos = [this.expr()];
    while (this.accept(",")) infos.push(this.expr());
    return { infos };
  }

  private expr(limit = 0): ExprInfo {
    this.enter();
    let left: ExprInfo;
    const t = this.tok;
    const isUnary = (t.type === "keyword" && t.text === "not") || (t.type === "op" && (t.text === "-" || t.text === "#" || t.text === "~"));
    if (isUnary) {
      this.next();
      this.expr(UNARY_PRIORITY);
      left = NO_EXPR;
    } else {
      left = this.simpleExpr();
    }
    for (;;) {
      const op = this.tok;
      const pri = (op.type === "op" || op.type === "keyword") ? BINARY[op.text] : undefined;
      if (!pri || pri[0] <= limit) break;
      this.next();
      this.expr(pri[1]);
      left = NO_EXPR;
    }
    this.leave();
    return left;
  }

  private simpleExpr(): ExprInfo {
    const t = this.tok;
    switch (t.type) {
      case "number":
        this.next();
        return NO_EXPR;
      case "string":
        this.next();
        return { multi: false, str: t.value, fn: null, prefix: null };
      case "keyword":
        if (t.text === "nil" || t.text === "true" || t.text === "false") {
          this.next();
          return NO_EXPR;
        }
        if (t.text === "function") {
          this.next();
          const body = this.funcBody(false, t.line);
          return { multi: false, str: null, fn: { params: body.params, vararg: body.vararg }, prefix: null };
        }
        break;
      case "op":
        if (t.text === "...") {
          if (!this.fn.vararg) this.fail("cannot use '...' outside a vararg function");
          this.next();
          return { multi: true, str: null, fn: null, prefix: null };
        }
        if (t.text === "{") {
          this.tableConstructor();
          return NO_EXPR;
        }
        break;
      default:
    }
    return this.suffixedExpr();
  }

  private tableConstructor(): void {
    const line = this.tok.line;
    this.expect("{");
    while (!this.is("}")) {
      if (this.is("[")) {
        this.next();
        const key = this.expr();
        this.expect("]");
        this.expect("=");
        const value = this.expr();
        if (value.fn && key.str !== null) this.memberFunctions.add(key.str);
      } else if (this.tok.type === "name" && this.peekAt(1).type === "op" && this.peekAt(1).text === "=") {
        const key = this.next().text;
        this.next();
        const value = this.expr();
        if (value.fn) this.memberFunctions.add(key);
      } else {
        this.expr();
      }
      if (!this.accept(",") && !this.accept(";")) break;
    }
    this.expectMatch("}", "{", line);
  }

  private primaryExpr(): ExprInfo {
    const t = this.tok;
    if (t.type === "name") {
      this.next();
      const root = this.isLocal(t.text) ? "local" : "global";
      return { multi: false, str: null, fn: null, prefix: { kind: "name", chain: [t.text], dynamic: false, root } };
    }
    if (this.is("(")) {
      const line = t.line;
      this.next();
      this.expr();
      this.expectMatch(")", "(", line);
      return { multi: false, str: null, fn: null, prefix: { kind: "paren", chain: [], dynamic: false, root: "other" } };
    }
    return this.fail("unexpected symbol");
  }

  private suffixedExpr(): ExprInfo {
    const startTok = this.tok;
    let cur = this.primaryExpr();
    for (;;) {
      const t = this.tok;
      const prefix = cur.prefix as Prefix;
      if (t.type === "op" && t.text === ".") {
        this.next();
        const key = this.name();
        cur = this.indexed(prefix, key, false);
      } else if (t.type === "op" && t.text === "[") {
        this.next();
        const key = this.expr();
        this.expect("]");
        cur = key.str !== null ? this.indexed(prefix, key.str, false) : this.indexed(prefix, "?", true);
      } else if (t.type === "op" && t.text === ":") {
        this.next();
        const key = this.name();
        const target = this.indexed(prefix, key, false);
        cur = this.callArgs(target.prefix as Prefix, true, startTok);
      } else if (t.type === "string" || (t.type === "op" && (t.text === "(" || t.text === "{"))) {
        cur = this.callArgs(prefix, false, startTok);
      } else {
        return cur;
      }
    }
  }

  private indexed(prefix: Prefix, key: string, dynamic: boolean): ExprInfo {
    const next: Prefix = {
      kind: "index",
      chain: prefix.kind === "call" || prefix.kind === "paren" ? ["?", key] : [...prefix.chain, key],
      dynamic: prefix.dynamic || dynamic || prefix.kind === "call" || prefix.kind === "paren",
      root: prefix.kind === "call" ? "call" : prefix.kind === "paren" ? "other" : prefix.root,
    };
    return { multi: false, str: null, fn: null, prefix: next };
  }

  private callArgs(callee: Prefix, method: boolean, startTok: Token): ExprInfo {
    const open = this.tok;
    const infos: ExprInfo[] = [];
    if (open.type === "string") {
      this.next();
      infos.push({ multi: false, str: open.value, fn: null, prefix: null });
    } else if (open.type === "op" && open.text === "{") {
      this.tableConstructor();
      infos.push(NO_EXPR);
    } else {
      const line = open.line;
      this.expect("(");
      if (!this.is(")")) infos.push(...this.exprList().infos);
      this.expectMatch(")", "(", line);
    }
    const last = infos[infos.length - 1];
    const text = callee.dynamic
      ? `${callee.chain.join(".")}`
      : method
        ? `${callee.chain.slice(0, -1).join(".")}:${callee.chain[callee.chain.length - 1]}`
        : callee.chain.join(".");
    this.calls.push({
      chain: callee.chain,
      text,
      method,
      root: callee.root,
      dynamic: callee.dynamic,
      argc: infos.length,
      variadicTail: !!last && (last.multi || last.prefix?.kind === "call"),
      stringArgs: infos.map((x) => x.str),
      functionArgs: infos.flatMap((x, index) => (x.fn ? [{ index, params: x.fn.params, vararg: x.fn.vararg }] : [])),
      line: startTok.line,
      column: startTok.column,
    });
    return { multi: true, str: null, fn: null, prefix: { kind: "call", chain: [], dynamic: false, root: "call" } };
  }

  // ---- functions -----------------------------------------------------------------------------
  private funcBody(method: boolean, line: number): { params: string[]; vararg: boolean; endLine: number } {
    const params: string[] = [];
    let vararg = false;
    this.open();
    if (method) this.declare("self");
    this.expect("(");
    if (!this.is(")")) {
      do {
        if (this.is("...")) {
          this.next();
          vararg = true;
          break;
        }
        const p = this.name();
        params.push(p);
        this.declare(p);
      } while (this.accept(","));
    }
    this.expect(")");
    this.fnStack.push({ vararg, loops: 0 });
    this.block();
    this.fnStack.pop();
    const endLine = this.tok.line;
    this.expectMatch("end", "function", line);
    this.close();
    return { params, vararg, endLine };
  }
}

export function parseLua(source: string): LuaParseResult {
  try {
    const tokens = tokenize(source);
    const parser = new Parser(tokens);
    parser.parseChunk();
    return {
      ok: true,
      calls: parser.calls,
      functions: parser.functions,
      units: parser.units,
      globalsAssigned: [...parser.globalsAssigned],
      locals: [...parser.locals],
      memberFunctions: [...parser.memberFunctions],
      lines: source.length === 0 ? 0 : source.split(/\r\n|\n|\r/).length,
    };
  } catch (error) {
    if (error instanceof LuaSyntaxError) return { ok: false, error: { message: error.message, line: error.line, column: error.column } };
    throw error;
  }
}
