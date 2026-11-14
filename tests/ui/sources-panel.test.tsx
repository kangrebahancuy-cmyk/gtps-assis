/**
 * Server-side render of the documentation sources shown under an answer, fed with the real
 * retrieval result for the synthetic fixture documentation. Checks structure and wording:
 * numbers, titles, sections, links, cited/not cited, and the honest notes for "nothing found".
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SourcesPanel } from "@/features/chat/sources-panel";
import type { StoredMessage } from "@/lib/chat/types";
import { retrieve } from "@/server/rag/retrieve";
import { BASE, seededDb } from "../support/gtps-docs-fixture";

(globalThis as { React?: unknown }).React = React;

const { db } = seededDb();
const reply = (question: string, content: string, status: StoredMessage["status"] = "complete"): StoredMessage => {
  const found = retrieve(db, [{ role: "user", content: question }]);
  return { id: "m", conversationId: "c", order: 1, role: "assistant", content, createdAt: 1, updatedAt: 1, status, provider: "groq", model: "m", meta: { docs: found.info } };
};
const html = (m: StoredMessage) => renderToStaticMarkup(<SourcesPanel message={m} />);

describe("SourcesPanel", () => {
  it("lists every source with its page, section, kind, original URL and excerpt, and opens it in the viewer", () => {
    const m = reply("What does Player:getName return?", "It returns a string [1].");
    const out = html(m);
    const docs = m.meta.docs!;
    assert.match(out, /data-testid="sources"/);
    assert.match(out, new RegExp(`${docs.sectionsSent} section`));
    assert.equal((out.match(/data-testid="source-item"/g) ?? []).length, docs.citations.length);
    assert.match(out, /Player › Player:getName/);
    assert.match(out, /API entry/);
    assert.ok(out.includes(`href="${BASE}/player"`), "the original URL is a link");
    assert.match(out, /rel="noopener noreferrer"/);
    assert.match(out, new RegExp(`href="/docs\\?doc=${docs.citations[0]!.documentId}[^"]*"`), "the in-app link opens the page");
    assert.match(out, /Source excerpt/);
    assert.match(out, /Signature: Player:getName\(\)/);
  });

  it("marks which sources the answer cites and which it does not (only once it is finished)", () => {
    const done = html(reply("What does Player:getName return?", "It returns a string [1]."));
    assert.match(done, />cited</);
    assert.match(done, /not cited/);
    assert.match(done, /1 cited in the answer/);
    const live = html(reply("What does Player:getName return?", "It returns", "streaming"));
    assert.doesNotMatch(live, /not cited/);
  });

  it("says plainly when nothing relevant was found or the index is empty, and lists invented names as not found", () => {
    const none = html(reply("How do I use Player:teleportToMoon?", "I could not find it."));
    assert.match(none, /data-testid="docs-none"/);
    assert.match(none, /No relevant documentation was found/);
    assert.match(none, /Not found in the indexed API entries: Player:teleportToMoon/);
    assert.doesNotMatch(none, /data-testid="sources"/);
    const m = reply("hello", "hi");
    m.meta.docs = { ...m.meta.docs!, status: "unavailable", reason: "No documentation is indexed yet." };
    assert.match(html(m), /No documentation is indexed yet/);
  });

  it("shows conflicts and removed instruction lines when they happened, and nothing for greetings or non-searched replies", () => {
    const conflict = html(reply("What is the signature of Player:onConsoleMessage?", "See [1] and [2]."));
    assert.match(conflict, /data-testid="docs-conflict"/);
    assert.match(conflict, /Conflicting documentation: Player:onConsoleMessage/);
    const injected = html(reply("How do I change a player's nickname?", "Use setNickname [1]."));
    assert.match(injected, /data-testid="docs-removed"/);
    assert.match(injected, /3 lines of documentation text looked like instructions to an AI and were removed/);
    assert.doesNotMatch(injected, /IGNORE ALL PREVIOUS/);
    assert.equal(html(reply("hello, thanks!", "hi")), "");
    const plain = reply("x", "y");
    delete plain.meta.docs;
    assert.equal(html(plain), "");
  });
});
