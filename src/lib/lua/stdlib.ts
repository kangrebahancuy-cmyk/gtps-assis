/** Standard Lua (5.1-5.4) names. These are NOT GTPS APIs; the verifier must never present them as such. */

export const LUA_GLOBAL_FUNCTIONS = new Set([
  "assert", "collectgarbage", "dofile", "error", "getmetatable", "ipairs", "load", "loadfile", "loadstring", "next",
  "pairs", "pcall", "print", "rawequal", "rawget", "rawlen", "rawset", "require", "select", "setmetatable",
  "tonumber", "tostring", "type", "unpack", "xpcall", "setfenv", "getfenv",
]);

export const LUA_LIBRARIES: Record<string, Set<string>> = {
  string: new Set(["byte", "char", "dump", "find", "format", "gmatch", "gsub", "len", "lower", "match", "pack", "packsize", "rep", "reverse", "sub", "unpack", "upper"]),
  table: new Set(["concat", "insert", "move", "pack", "remove", "sort", "unpack", "getn", "maxn"]),
  math: new Set(["abs", "acos", "asin", "atan", "atan2", "ceil", "cos", "cosh", "deg", "exp", "floor", "fmod", "frexp", "ldexp", "log", "log10", "max", "min", "modf", "pow", "rad", "random", "randomseed", "sin", "sinh", "sqrt", "tan", "tanh", "tointeger", "type", "ult"]),
  os: new Set(["clock", "date", "difftime", "execute", "exit", "getenv", "remove", "rename", "setlocale", "time", "tmpname"]),
  io: new Set(["close", "flush", "input", "lines", "open", "output", "popen", "read", "tmpfile", "type", "write"]),
  coroutine: new Set(["close", "create", "isyieldable", "resume", "running", "status", "wrap", "yield"]),
  utf8: new Set(["char", "codepoint", "len", "offset", "codes"]),
  debug: new Set(["debug", "gethook", "getinfo", "getlocal", "getmetatable", "getregistry", "getupvalue", "sethook", "setlocal", "setmetatable", "setupvalue", "traceback"]),
  package: new Set(["loadlib", "searchpath"]),
  bit32: new Set(["band", "bor", "bxor", "bnot", "lshift", "rshift", "arshift", "lrotate", "rrotate", "extract", "replace"]),
};

/** Lua's own method-call syntax on strings: `("x"):rep(3)`, `name:sub(1, 2)`. */
export const STRING_METHODS = LUA_LIBRARIES.string as Set<string>;

/** Functions a game-server sandbox commonly blocks. The documentation decides; the verifier only warns. */
export const RESTRICTED_LUA = new Set([
  "os.execute", "os.exit", "os.remove", "os.rename", "os.getenv", "os.tmpname", "io.open", "io.popen", "io.read", "io.write", "io.lines",
  "io.input", "io.output", "io.tmpfile", "debug", "dofile", "loadfile", "load", "loadstring", "require", "package",
]);

export function isRestrictedLua(name: string): boolean {
  return RESTRICTED_LUA.has(name) || RESTRICTED_LUA.has(name.split(".")[0] ?? "") && /^(debug|package)\./.test(name);
}
