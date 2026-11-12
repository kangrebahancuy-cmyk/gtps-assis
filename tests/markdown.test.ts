import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isLua, tokenizeLua } from "@/lib/lua-highlight";
import { markdownToPlainText } from "@/lib/markdown-plain";
import { parseInline, parseMarkdown } from "@/lib/markdown";

describe("parseMarkdown", () => {
  it("parses headings 1-6 with unique ids, paragraphs and fenced code", () => {
    const blocks = parseMarkdown("# Player\n\nText line one\nline two\n\n#### Deep\n\n## Player\n\n```lua\nlocal a = 1\n```\n");
    assert.deepEqual(blocks.map((b) => b.type), ["heading", "paragraph", "heading", "heading", "code"]);
    assert.deepEqual(blocks.filter((b) => b.type === "heading").map((b) => (b.type === "heading" ? [b.level, b.id] : null)), [[1, "player"], [4, "deep"], [2, "player-1"]]);
    assert.equal(blocks[1]?.type === "paragraph" && blocks[1].text, "Text line one line two");
    assert.deepEqual(blocks[4], { type: "code", language: "lua", code: "local a = 1" });
  });
  it("handles longer fences and does not end a block on a shorter inner fence", () => {
    const [block] = parseMarkdown("````json\n{\"a\": \"```\"}\n````");
    assert.deepEqual(block, { type: "code", language: "json", code: '{"a": "```"}' });
  });
  it("keeps an unterminated fence's content instead of dropping it", () => {
    assert.deepEqual(parseMarkdown("```lua\nprint(1)")[0], { type: "code", language: "lua", code: "print(1)" });
  });
  it("parses GFM tables with alignment, padding short rows and unescaping pipes", () => {
    const [table] = parseMarkdown("| Name | Type |\n| :--- | ---: |\n| a\\|b | x |\n| only |");
    assert.equal(table?.type, "table");
    if (table?.type !== "table") return;
    assert.deepEqual(table.header, ["Name", "Type"]);
    assert.deepEqual(table.align, ["left", "right"]);
    assert.deepEqual(table.rows, [["a\\|b", "x"], ["only", ""]]);
  });
  it("parses nested and ordered lists", () => {
    const [list] = parseMarkdown("- one\n  - inner a\n  - inner b\n- two");
    assert.equal(list?.type, "list");
    if (list?.type !== "list") return;
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items[0]?.children?.items.map((i) => i.text), ["inner a", "inner b"]);
    const [ordered] = parseMarkdown("1. a\n2. b");
    assert.equal(ordered?.type === "list" && ordered.ordered, true);
  });
  it("a pipe in a paragraph is not a table, and always makes progress on odd input", () => {
    assert.equal(parseMarkdown("a | b\nc")[0]?.type, "paragraph");
    assert.doesNotThrow(() => parseMarkdown("|\n---\n|||\n```\n#\n- \n"));
  });
  it("round-trips what the extractor produces", () => {
    const md = "# Player\n\nSee [World](https://x.test/docs/world) and `Player`.\n\n| Name | Type |\n| --- | --- |\n| id | number |\n\n```lua\nPlayer:getName()\n```";
    assert.deepEqual(parseMarkdown(md).map((b) => b.type), ["heading", "paragraph", "table", "code"]);
  });
});

describe("parseInline", () => {
  it("parses code, bold, italic and https links", () => {
    assert.deepEqual(parseInline("a `b` **c** *d* [e](https://x.test/y)"), [
      { type: "text", text: "a " },
      { type: "code", text: "b" },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "em", children: [{ type: "text", text: "d" }] },
      { type: "text", text: " " },
      { type: "link", href: "https://x.test/y", children: [{ type: "text", text: "e" }] },
    ]);
  });
  it("never produces a link for javascript: or relative targets", () => {
    const nodes = parseInline("[x](javascript:alert(1)) [y](/docs/z)");
    assert.ok(!nodes.some((n) => n.type === "link"));
    assert.ok(nodes.some((n) => n.type === "text" && n.text.includes("x")));
  });
  it("keeps markdown-looking text inside code spans literal and unescapes pipes", () => {
    assert.deepEqual(parseInline("`**x**`"), [{ type: "code", text: "**x**" }]);
    assert.deepEqual(parseInline("a\\|b"), [{ type: "text", text: "a|b" }]);
    assert.deepEqual(parseInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
  });
});

describe("tokenizeLua", () => {
  const types = (src: string) => tokenizeLua(src).filter((t) => t.type !== "plain").map((t) => [t.type, t.text]);

  it("highlights keywords, constants, strings, numbers, comments and calls", () => {
    assert.deepEqual(types('local x = 10 -- count\nif x then print("hi") end return nil'), [
      ["keyword", "local"], ["number", "10"], ["comment", "-- count"], ["keyword", "if"], ["keyword", "then"],
      ["function", "print"], ["string", '"hi"'], ["keyword", "end"], ["keyword", "return"], ["constant", "nil"],
    ]);
  });
  it("handles method calls, callbacks, long strings and long comments", () => {
    assert.deepEqual(types("player:getName()\nonPlayerChatCallback(function(w) end)"), [
      ["function", "getName"], ["function", "onPlayerChatCallback"], ["keyword", "function"], ["keyword", "end"],
    ]);
    assert.deepEqual(types("--[[ a\nb ]] local s = [==[x]]y]==]"), [["comment", "--[[ a\nb ]]"], ["keyword", "local"], ["string", "[==[x]]y]==]"]]);
  });
  it("treats keyword-like member names as plain and escapes inside strings", () => {
    assert.deepEqual(types("t.end = 'it\\'s'"), [["string", "'it\\'s'"]]);
  });
  it("never loses or reorders text, whatever the input", () => {
    const samples = ['"unterminated', "--[[ never closed", "0x1F + 1.5e3 .5", "a:b(c).d[e]", "[[x", "\n\n  \t", "é ü 日本", "[=[", "x = 'a\nb'"];
    for (const s of samples) assert.equal(tokenizeLua(s).map((t) => t.text).join(""), s, JSON.stringify(s));
  });
  it("identifies Lua language labels", () => {
    assert.ok(isLua("lua") && isLua("Lua") && !isLua("json") && !isLua(null));
  });
});

describe("markdownToPlainText", () => {
  it("keeps prose and table cells, drops code fences and Markdown syntax", () => {
    const text = markdownToPlainText("# Player\n\nSee [World](https://x.test/w) and `Player` **now**.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n```lua\nsecretCode()\n```\n- item");
    assert.equal(text, "Player\nSee World and Player now.\nA B\n1 2\nitem");
  });
});
