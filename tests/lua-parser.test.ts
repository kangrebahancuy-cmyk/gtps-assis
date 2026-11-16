import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLua } from "@/lib/lua/parser";

function ok(src: string) {
  const r = parseLua(src);
  assert.ok(r.ok, r.ok ? "" : `${r.error.message} @${r.error.line}:${r.error.column}`);
  return r.ok ? r : (undefined as never);
}
function bad(src: string) {
  const r = parseLua(src);
  assert.equal(r.ok, false, "expected a syntax error");
  return r.ok ? (undefined as never) : r.error;
}

describe("lua parser: valid programs", () => {
  it("accepts a broad range of Lua syntax", () => {
    ok(`
      local a, b <const> = 1, 2.5e3
      local t = { 1, 2; x = 3, ["y"] = 4, [5] = f(), g = function(...) return ... end }
      for i = 1, 10, 2 do if i % 2 == 0 then goto continue end print(i) ::continue:: end
      for k, v in pairs(t) do print(k, v) end
      while a < 3 do a = a + 1 if a == 2 then break end end
      repeat local z = a; a = a - 1 until z == 0
      local s = [==[long ]] string]==] .. "esc\\n\\x41\\65\\u{48}" .. 'q'
      --[[ block
      comment ]] -- line comment
      --[==[ another ]==]
      local n = #t + -a ^ 2 // 3 | 1 & 2 ~ 3 << 1 >> 1
      function Foo.bar:baz(x, y) return self, x, y end
      local function fact(n) if n <= 1 then return 1 end return n * fact(n - 1) end
      print(("x"):rep(3), #"abc", not nil)
      do local q = 0x1F + 0xA.8p1 end
      return fact(5)
    `);
  });

  it("handles empty input, comments only and shebang", () => {
    ok("");
    ok("-- just a comment");
    ok("#!/usr/bin/lua\nprint(1)");
  });

  it("accepts call forms: string and table arguments, method chains", () => {
    const r = ok(`f"str"; f{1,2}; a.b.c(1); a.b:c(1, 2); x:y():z(); f(g())`);
    const texts = r.calls.map((c) => c.text);
    assert.ok(texts.includes("a.b.c"));
    assert.ok(texts.includes("a.b:c"));
  });
});

describe("lua parser: syntax errors", () => {
  it("reports a missing end with the opening line", () => {
    const e = bad(`function f()\n  print(1)\n`);
    assert.match(e.message, /'end' expected \(to close 'function' at line 1\) near <eof>/);
  });
  it("reports a missing 'then'", () => {
    const e = bad(`if x == 1\n  print(1)\nend`);
    assert.match(e.message, /'then' expected near 'print'/);
    assert.equal(e.line, 2);
  });
  it("reports unfinished strings", () => {
    assert.match(bad(`local a = "abc\nprint(a)`).message, /unfinished string/);
    assert.match(bad(`local a = [[abc`).message, /unfinished long string/);
  });
  it("reports unexpected symbols and stray tokens", () => {
    assert.match(bad(`local a = = 1`).message, /unexpected symbol near '='/);
    assert.match(bad(`print(1) )`).message, /unexpected symbol near '\)'/);
    assert.match(bad(`x = 1 @ 2`).message, /unexpected symbol near '@'/);
  });
  it("rejects an expression used as a statement", () => {
    assert.match(bad(`a.b`).message, /syntax error near <eof>/);
    assert.match(bad(`1 + 2`).message, /unexpected symbol near '1'/);
  });
  it("rejects invalid assignment targets and attribs", () => {
    assert.match(bad(`f() = 1`).message, /syntax error/);
    assert.match(bad(`local x <foo> = 1`).message, /unknown attribute 'foo'/);
  });
  it("rejects break outside loops and ... outside vararg functions", () => {
    assert.match(bad(`break`).message, /break outside a loop/);
    assert.match(bad(`function f() return ... end`).message, /cannot use '...' outside a vararg function/);
  });
  it("code after return is an error", () => {
    assert.match(bad(`function f() return 1 print(2) end`).message, /'end' expected/);
  });
  it("reports malformed numbers and bad escapes", () => {
    assert.match(bad(`x = 3x`).message, /malformed number/);
    assert.match(bad(`x = "\\q"`).message, /invalid escape sequence/);
  });
  it("reports unbalanced parentheses with line info", () => {
    const e = bad(`print(1,\n 2\nprint(3)`);
    assert.match(e.message, /'\)' expected/);
  });
  it("guards against runaway nesting", () => {
    assert.match(bad("x = " + "(".repeat(400) + "1" + ")".repeat(400)).message, /too many syntax levels/);
  });
  it("gives line and column", () => {
    const e = bad(`local a = 1\nlocal b = 2 +\n`);
    assert.equal(e.line, 3);
  });
});

describe("lua parser: extraction", () => {
  it("records call sites with chain, root, args and string args", () => {
    const r = ok(`
      local player = GetPlayer(1)
      player:sendMessage("hi", 3)
      AddHook("onPlayerJoin", "id", function(world, p) end)
      string.format("%d", 1)
      GetWorld(name):getTiles(...)
    `);
    const by = (t: string) => r.calls.find((c) => c.text === t);
    assert.deepEqual(by("player:sendMessage")?.stringArgs, ["hi", null]);
    assert.equal(by("player:sendMessage")?.argc, 2);
    assert.equal(by("player:sendMessage")?.root, "local");
    assert.equal(by("player:sendMessage")?.method, true);
    assert.equal(by("AddHook")?.root, "global");
    assert.deepEqual(by("AddHook")?.functionArgs, [{ index: 2, params: ["world", "p"], vararg: false }]);
    assert.equal(by("string.format")?.root, "global");
    assert.equal(by("GetWorld")?.argc, 1);
    const chained = r.calls.find((c) => c.method && c.chain[0] === "?");
    assert.ok(chained, "method call on a call result");
    assert.equal(chained?.root, "call");
    assert.equal(chained?.variadicTail, true);
  });

  it("marks computed keys as dynamic", () => {
    const r = ok(`local t = {} t[i]:go() t["x"].y()`);
    assert.equal(r.calls.find((c) => c.text.endsWith("go"))?.dynamic, true);
    const y = r.calls.find((c) => c.chain.join(".") === "t.x.y");
    assert.equal(y?.dynamic, false);
  });

  it("records function definitions", () => {
    const r = ok(`
      function onPlayerJoin(world, player) end
      local function helper(a, ...) end
      Shop = {}
      function Shop:buy(item) end
      Handler = function(x) end
    `);
    const names = r.functions.map((f) => f.name);
    assert.deepEqual(names, ["onPlayerJoin", "helper", "Shop:buy", "Handler"]);
    assert.deepEqual(r.functions[0]?.params, ["world", "player"]);
    assert.equal(r.functions[1]?.vararg, true);
    assert.equal(r.functions[2]?.method, true);
    assert.ok(r.globalsAssigned.includes("Shop"));
    assert.ok(r.globalsAssigned.includes("onPlayerJoin"));
  });

  it("splits top-level units with stable fingerprints", () => {
    const a = ok(`local x = 1\nfunction f()\n  return x\nend\nprint("a")`);
    assert.deepEqual(a.units.map((u) => `${u.kind}:${u.name}`), ["local:x", "function:f", 'call:print("a")']);
    const b = ok(`-- comment\nlocal   x=1\nfunction f() return x end\nprint('a')`);
    assert.deepEqual(b.units.map((u) => u.fingerprint), a.units.map((u) => u.fingerprint));
    assert.equal(a.units[1]?.line, 2);
    assert.equal(a.units[1]?.endLine, 4);
  });
});
