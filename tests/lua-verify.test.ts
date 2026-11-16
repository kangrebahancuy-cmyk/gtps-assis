import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractScript, codeBlocks } from "@/lib/lua/extract";
import { verifyScript } from "@/server/lua/verify";
import { seededDb } from "./support/gtps-docs-fixture";

const { db } = seededDb();
const check = (code: string, original?: string) => verifyScript(db, code, original ? { original } : {});
const kinds = (code: string, severity?: string) => check(code).findings.filter((f) => !severity || f.severity === severity).map((f) => f.kind);
const use = (c: ReturnType<typeof check>, name: string) => c.apiUses.find((u) => u.name === name);

const GOOD = `
-- Greets players and logs chat
local greeted = {}
onPlayerEnterWorldCallback(function(world, player)
  local name = player:getName()
  player:onConsoleMessage("Welcome, " .. name)
  logToConsole(string.format("%s joined at %d", name, os.time()))
end)
onPlayerChatCallback(function(world, player, message)
  if message:find("spam") then return true end
  return false
end)
local id = timer.setInterval(60, function() logToConsole("tick") end)
`;

describe("verifyScript: documented scripts", () => {
  it("passes a script that only uses documented APIs", () => {
    const c = check(GOOD);
    assert.equal(c.syntax.ok, true);
    assert.deepEqual(c.findings.filter((f) => f.severity === "error"), []);
    assert.equal(c.passed, true);
    assert.equal(use(c, "player:getName")?.status, "documented");
    assert.equal(use(c, "player:getName")?.documentedAs, "Player:getName");
    assert.match(use(c, "player:getName")?.source?.url ?? "", /docs\.fixture\.test/);
    assert.equal(use(c, "onPlayerChatCallback")?.kind, "callback");
    assert.equal(use(c, "timer.setInterval")?.status, "documented");
  });

  it("classifies standard Lua separately from GTPS API", () => {
    const c = check(GOOD);
    assert.equal(use(c, "string.format")?.status, "lua_standard");
    assert.equal(use(c, "os.time")?.status, "lua_standard");
    assert.equal(use(c, "message:find")?.status, "lua_standard");
    assert.equal(c.apiUses.some((u) => u.status === "documented" && u.name.startsWith("string.")), false);
  });

  it("counts real stats", () => {
    const c = check(GOOD);
    assert.equal(c.stats.units, 4);
    assert.ok(c.stats.calls >= 9);
  });
});

describe("verifyScript: invented APIs", () => {
  it("flags an undocumented global function and method", () => {
    const c = check(`local p = getPlayer("a")\nGiveGems(p, 10)\np:teleportToMoon()`);
    const bad = c.findings.filter((f) => f.kind === "undocumented_api").map((f) => f.name);
    assert.deepEqual(bad.sort(), ["GiveGems", "p:teleportToMoon"].sort());
    assert.equal(c.passed, false);
    assert.equal(use(c, "getPlayer")?.status, "documented");
    assert.equal(use(c, "GiveGems")?.status, "undocumented");
  });

  it("is case-sensitive and suggests the documented spelling", () => {
    const c = check(`getplayer("a")`);
    const f = c.findings.find((x) => x.kind === "undocumented_api");
    assert.ok(f);
    assert.match(f?.message ?? "", /Did you mean getPlayer\?/);
  });

  it("flags unknown event names, as handlers and as strings", () => {
    assert.deepEqual(kinds(`function onPlayerJoinWorld(world, player) end`, "error"), ["unknown_event"]);
    assert.deepEqual(kinds(`RegisterEvent("onPlayerDance", function() end)`, "error").sort(), ["undocumented_api", "unknown_event"]);
    const c = check(`function onPlayerEnterWorldCallback(world, player) end`);
    assert.equal(c.passed, true);
    assert.equal(use(c, "onPlayerEnterWorldCallback")?.status, "documented");
  });

  it("does not treat Lua standard functions as GTPS API", () => {
    const c = check(`string.foo("x")\nos.execute("ls")\nio.open("f")\nloadstring("x")()`);
    const f = c.findings;
    assert.ok(f.some((x) => x.kind === "lua_standard" && x.severity === "error" && x.name === "string.foo"));
    assert.equal(f.filter((x) => x.kind === "restricted_lua").length, 3);
    assert.equal(use(c, "os.execute")?.status, "lua_standard");
    assert.equal(use(c, "string.foo")?.status, "undocumented");
  });
});

describe("verifyScript: parameters and callbacks", () => {
  it("checks argument counts against the documented parameters", () => {
    assert.deepEqual(kinds(`local p = getPlayer("a")\np:onConsoleMessage()`, "error"), ["wrong_arguments"]);
    assert.deepEqual(kinds(`local p = getPlayer("a")\np:onConsoleMessage("a", "b", "c")`, "error"), ["wrong_arguments"]);
    assert.deepEqual(kinds(`getPlayer()`, "error"), ["wrong_arguments"]);
    assert.deepEqual(kinds(`local w = getPlayer("a")\nw:enterWorld("START")`, "error"), ["wrong_arguments"]);
    assert.deepEqual(kinds(`local p = getPlayer("a")\np:enterWorld("START", 0)`, "error"), []);
  });

  it("accepts an argument list that ends in a call (it may expand)", () => {
    assert.deepEqual(kinds(`local p = getPlayer("a")\np:enterWorld(unpack(t))`, "error"), []);
  });

  it("accepts either spelling of the colon/dot call for documented methods", () => {
    assert.deepEqual(kinds(`Player.getName(p)`, "error"), []);
    assert.deepEqual(kinds(`Player.enterWorld(p, "A", 0)`, "error"), []);
    assert.deepEqual(kinds(`Player.enterWorld(p, "A")`, "error"), ["wrong_arguments"]);
  });

  it("checks handler parameters against the documented callback", () => {
    const more = check(`onPlayerChatCallback(function(world, player, message, extra) end)`);
    assert.ok(more.findings.some((f) => f.kind === "callback_signature" && f.severity === "warning"));
    const fewer = check(`onPlayerChatCallback(function(world, player) end)`);
    assert.ok(fewer.findings.some((f) => f.kind === "callback_signature" && f.severity === "info"));
    assert.equal(fewer.passed, true);
    const noFn = check(`onPlayerChatCallback()`);
    assert.ok(noFn.findings.some((f) => f.kind === "wrong_arguments"));
  });
});

describe("verifyScript: script-defined names are not flagged", () => {
  it("accepts methods and helpers the script defines", () => {
    const c = check(`
      local Shop = {}
      function Shop:buy(item) return item end
      function Shop.price(item) return 1 end
      local Tools = { greet = function(self, n) return n end }
      local function helper(a) return a end
      Shop:buy("x") Shop.price("x") Tools:greet("a") helper(1)
      function Global(a) end
      Global(1)
    `);
    assert.deepEqual(c.findings.filter((f) => f.severity === "error"), []);
    assert.equal(c.apiUses.length, 0);
  });
});

describe("verifyScript: structure", () => {
  it("reports syntax errors with line and no API analysis", () => {
    const c = check(`local x = 1\nif x then\n  print(x)\n`);
    assert.equal(c.passed, false);
    assert.equal(c.syntax.ok, false);
    if (!c.syntax.ok) assert.equal(c.syntax.line, 4);
    assert.match(c.findings[0]?.message ?? "", /'end' expected \(to close 'if' at line 2\)/);
  });

  it("rejects abbreviated scripts and empty scripts", () => {
    assert.ok(check(`local a = 1\n-- ... rest of the code\n`).findings.some((f) => f.kind === "incomplete"));
    assert.ok(check(`function f() end\n-- existing code unchanged\n`).findings.some((f) => f.kind === "incomplete"));
    assert.ok(check(``).findings.some((f) => f.kind === "incomplete"));
    assert.equal(check(`-- only comments`).passed, false);
  });

  it("warns about calls it cannot verify instead of guessing", () => {
    const c = check(`local t = getPlayer("a")\nt.something("x")`);
    assert.ok(c.findings.some((f) => f.kind === "unverified_call" && f.severity === "warning"));
    assert.equal(c.passed, true);
  });
});

describe("verifyScript: preservation", () => {
  const ORIGINAL = `
local prefix = "[Shop] "
function showHelp(player)
  player:onConsoleMessage(prefix .. "help")
end
onPlayerChatCallback(function(world, player, message)
  if message == "!help" then showHelp(player) return true end
  return false
end)
logToConsole("loaded")
`;
  it("lists preserved, modified, removed and added parts", () => {
    const updated = `
local prefix = "[Shop] "
function showHelp(player)
  player:onConsoleMessage(prefix .. "help!!")
end
function showPrice(player) player:onConsoleMessage("5") end
logToConsole("loaded")
`;
    const c = check(updated, ORIGINAL);
    const p = c.preservation;
    assert.ok(p);
    assert.deepEqual(p?.preserved.sort(), ['call logToConsole("loaded")', 'local prefix'].sort());
    assert.deepEqual(p?.modified, ["function showHelp"]);
    assert.deepEqual(p?.removed, ['call onPlayerChatCallback']);
    assert.deepEqual(p?.added, ["function showPrice"]);
    assert.ok(c.findings.some((f) => f.kind === "removed_feature"));
    assert.equal(c.passed, true, "a removal is a warning, not an error");
  });

  it("an unchanged script preserves everything, whitespace and comments aside", () => {
    const c = check(ORIGINAL.replace("prefix = ", "prefix   =  ") + "\n-- a comment\n", ORIGINAL);
    assert.equal(c.preservation?.removed.length, 0);
    assert.equal(c.preservation?.modified.length, 0);
    assert.equal(c.preservation?.preserved.length, 4);
  });

  it("skips the comparison when the original does not parse", () => {
    const c = check(`print(1)`, `if x then`);
    assert.equal(c.preservation, null);
    assert.ok(c.findings.some((f) => f.kind === "preservation_skipped"));
  });
});

describe("extractScript", () => {
  it("picks the longest lua block, ignoring console snippets", () => {
    const md = "## Code\n```lua\nprint(1)\nprint(2)\n```\n\nUse `/daily`:\n```\n/daily\n```\n```lua\nprint('short')\n```\n";
    const s = extractScript(md);
    assert.equal(s?.code, "print(1)\nprint(2)");
    assert.equal(codeBlocks(md).length, 3);
  });
  it("falls back to an unlabelled block, and handles an unclosed fence while streaming", () => {
    assert.equal(extractScript("```\nlocal a = 1\n```")?.code, "local a = 1");
    const open = extractScript("text\n```lua\nlocal a = 1\nlocal b");
    assert.equal(open?.closed, false);
    assert.equal(open?.code, "local a = 1\nlocal b");
    assert.equal(extractScript("no code here"), null);
  });
});
