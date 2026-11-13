/**
 * Server-Sent Events reader shared by the backend (provider streams) and the
 * browser (our own /api/ai/chat stream). Handles events split across network
 * chunks, multi-byte characters split across chunks, CRLF, comments and
 * multi-line `data:` fields.
 */

export interface SseMessage {
  event: string;
  data: string;
}

export class StreamIdleError extends Error {
  constructor(readonly idleMs: number) {
    super(`No data received for ${idleMs} ms`);
    this.name = "StreamIdleError";
  }
}

/** Reads a byte stream chunk by chunk, failing if no chunk arrives within `idleMs` or the signal aborts. */
export async function* iterateChunks(
  stream: ReadableStream<Uint8Array>,
  options: { idleMs?: number; signal?: AbortSignal } = {},
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  const { idleMs, signal } = options;

  // One abort listener for the whole stream (not one per chunk).
  let onAbort: (() => void) | undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        const fail = () => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) fail();
        else {
          onAbort = fail;
          signal.addEventListener("abort", fail, { once: true });
        }
      })
    : null;
  aborted?.catch(() => {}); // the race below observes it; this only prevents an unhandled rejection

  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const racers: Array<Promise<ReadableStreamReadResult<Uint8Array>>> = [reader.read()];
      if (idleMs) racers.push(new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StreamIdleError(idleMs)), idleMs); }));
      if (aborted) racers.push(aborted);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race(racers);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function* parseSse(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "message";
  let data: string[] = [];

  const dispatch = (): SseMessage | null => {
    if (data.length === 0) {
      event = "message";
      return null;
    }
    const message = { event, data: data.join("\n") };
    event = "message";
    data = [];
    return message;
  };

  function* consume(final: boolean): Generator<SseMessage> {
    for (;;) {
      const newline = buffer.search(/\r\n|\n|\r/);
      if (newline === -1) break;
      const match = /^(\r\n|\n|\r)/.exec(buffer.slice(newline))!;
      // A lone "\r" at the very end may be the first half of "\r\n": wait for more input.
      if (match[1] === "\r" && newline + 1 === buffer.length && !final) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + match[1]!.length);

      if (line === "") {
        const message = dispatch();
        if (message) yield message;
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "data") data.push(value);
        else if (field === "event") event = value;
      }
    }
  }

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    yield* consume(false);
  }
  buffer += decoder.decode();
  yield* consume(true);
  if (buffer && !buffer.startsWith(":")) {
    // Last line without a trailing newline.
    const colon = buffer.indexOf(":");
    if ((colon === -1 ? buffer : buffer.slice(0, colon)) === "data") data.push(colon === -1 ? "" : buffer.slice(colon + 1).replace(/^ /, ""));
  }
  const last = dispatch();
  if (last) yield last;
}
