import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { detectLanguage, parseSignature, readEntryDetails } from "@/server/scraper/api-parse";

describe("parseSignature", () => {
  it("parses method signatures with parameters", () => {
    assert.deepEqual(parseSignature("Player:enterWorld(worldName, notification, bypass)"), {
      name: "Player:enterWorld",
      params: ["worldName", "notification", "bypass"],
    });
  });
  it("parses parameterless methods and static functions", () => {
    assert.deepEqual(parseSignature("Player:getName()"), { name: "Player:getName", params: [] });
    assert.deepEqual(parseSignature("os.time()"), { name: "os.time", params: [] });
  });
  it("parses a callback registration line from the callbacks page", () => {
    assert.deepEqual(parseSignature("onPlayerChatCallback(function(world, player, message)"), {
      name: "onPlayerChatCallback",
      params: ["world", "player", "message"],
    });
  });
  it("never produces a parameter that contains a parenthesis", () => {
    assert.equal(parseSignature("foo(bar(baz))"), null);
  });
  it("rejects prose and code that is not a signature", () => {
    assert.equal(parseSignature("Returns the name for this avatar."), null);
    assert.equal(parseSignature("local x = foo()"), null);
  });
});

describe("detectLanguage", () => {
  it("keeps a declared language", () => {
    assert.equal(detectLanguage("whatever", "python"), "python");
  });
  it("recognises untagged Lua", () => {
    assert.equal(detectLanguage("local x = 1\nprint(x)", null), "lua");
    assert.equal(detectLanguage("onPlayerChatCallback(function(w, p, m)\n  -- code here\nend)", null), "lua");
    assert.equal(detectLanguage("Player:getName()", null), "lua");
  });
  it("returns null for text that does not look like code", () => {
    assert.equal(detectLanguage("just some words", null), null);
  });
});

describe("readEntryDetails", () => {
  it("reads description and return type, run together or separated", () => {
    const lines = ["Player:enterWorld(worldName, notification, bypass)", "Moves this avatar into a world.", "Parameters", "Returns void"];
    assert.deepEqual(readEntryDetails(lines, lines[0] as string), {
      description: "Moves this avatar into a world.",
      returns: "void",
    });
    assert.equal(readEntryDetails(["Returns: string"], "x()").returns, "string");
  });
  it("leaves fields null when the page does not provide them", () => {
    assert.deepEqual(readEntryDetails([], "x()"), { description: null, returns: null });
    assert.deepEqual(readEntryDetails(["Parameters"], "x()"), { description: null, returns: null });
  });
  it("treats a sentence that starts with 'Returns' as a description, not a return type", () => {
    const lines = ["Returns the name for this avatar.", "Returns string"];
    assert.deepEqual(readEntryDetails(lines, "x()"), { description: "Returns the name for this avatar.", returns: "string" });
    assert.equal(readEntryDetails(["Returns: a table of players"], "x()").returns, "a table of players");
  });
});
