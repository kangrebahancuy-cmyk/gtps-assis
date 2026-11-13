import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { iterateChunks, parseSse, StreamIdleError, type SseMessage } from "@/lib/sse";

const enc = new TextEncoder();

async function* chunksOf(...parts: Array<string | Uint8Array>): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield typeof p === "string" ? enc.encode(p) : p;
}
async function collect(it: AsyncIterable<SseMessage>): Promise<SseMessage[]> {
  const out: SseMessage[] = [];
  for await (const m of it) out.push(m);
  return out;
}

describe("parseSse", () => {
  it("parses simple events, event names, comments and multi-line data", async () => {
    const out = await collect(parseSse(chunksOf(": keep-alive\n\ndata: one\n\nevent: custom\ndata: a\ndata: b\n\n")));
    assert.deepEqual(out, [{ event: "message", data: "one" }, { event: "custom", data: "a\nb" }]);
  });
  it("handles CRLF and lone CR line endings", async () => {
    assert.deepEqual((await collect(parseSse(chunksOf("data: x\r\n\r\ndata: y\r\r")))).map((m) => m.data), ["x", "y"]);
  });
  it("reassembles events split at every possible byte boundary, including inside UTF-8 characters", async () => {
    const text = 'data: {"t":"wörld ✓ 日本 😀"}\n\ndata: [DONE]\n\n';
    const bytes = enc.encode(text);
    for (let size = 1; size <= 9; size++) {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) parts.push(bytes.subarray(i, i + size));
      const out = await collect(parseSse(chunksOf(...parts)));
      assert.deepEqual(out.map((m) => m.data), ['{"t":"wörld ✓ 日本 😀"}', "[DONE]"], `chunk size ${size}`);
    }
  });
  it("does not split CRLF when \\r and \\n arrive in different chunks", async () => {
    assert.deepEqual((await collect(parseSse(chunksOf("data: a\r", "\n\r", "\ndata: b\r\n\r\n")))).map((m) => m.data), ["a", "b"]);
  });
  it("delivers a final event that has no trailing blank line, and ignores empty ones", async () => {
    assert.deepEqual((await collect(parseSse(chunksOf("data: tail")))).map((m) => m.data), ["tail"]);
    assert.deepEqual(await collect(parseSse(chunksOf("\n\n\n", ": c\n\n"))), []);
  });
  it("strips only one leading space from values", async () => {
    assert.equal((await collect(parseSse(chunksOf("data:  two\n\n"))))[0]?.data, " two");
    assert.equal((await collect(parseSse(chunksOf("data:none\n\n"))))[0]?.data, "none");
  });
});

describe("iterateChunks", () => {
  const streamOf = (pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) => new ReadableStream<Uint8Array>({ pull });

  it("passes chunks through and finishes", async () => {
    let n = 0;
    const s = streamOf((c) => { if (n++ < 3) c.enqueue(enc.encode(`d${n}`)); else c.close(); });
    const got: string[] = [];
    for await (const chunk of iterateChunks(s)) got.push(new TextDecoder().decode(chunk));
    assert.deepEqual(got, ["d1", "d2", "d3"]);
  });
  it("fails with StreamIdleError when no chunk arrives in time", async () => {
    const s = streamOf(() => new Promise(() => {}));
    await assert.rejects(async () => { for await (const _ of iterateChunks(s, { idleMs: 20 })) void _; }, StreamIdleError);
  });
  it("stops when the signal aborts, without unhandled rejections", async () => {
    const controller = new AbortController();
    const s = streamOf(() => new Promise(() => {}));
    setTimeout(() => controller.abort(new Error("stop")), 10);
    await assert.rejects(async () => { for await (const _ of iterateChunks(s, { signal: controller.signal })) void _; }, /stop/);
    await new Promise((r) => setTimeout(r, 20)); // an unhandled rejection would crash the test run here
  });
  it("does not add an abort listener per chunk", async () => {
    const controller = new AbortController();
    let n = 0;
    const s = streamOf((c) => { if (n++ < 200) c.enqueue(enc.encode("x")); else c.close(); });
    let seen = 0;
    for await (const _ of iterateChunks(s, { signal: controller.signal })) { void _; seen++; }
    assert.equal(seen, 200);
  });
});
