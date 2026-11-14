/**
 * The real AI backend (handlers + AiService + provider adapters) in front of the
 * local fake Gemini/Groq servers, reachable two ways: in-process through a
 * `fetch`-shaped function (Node tests) or over HTTP (browser tests).
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

import { handleChat, handleGetSettings, handleModels, handleRemoveConfig, handleSaveConfig, handleTest } from "@/server/ai/api";
import { AiConfigStore } from "@/server/ai/config-store";
import { createGeminiProvider } from "@/server/ai/providers/gemini";
import { createGroqProvider } from "@/server/ai/providers/groq";
import { AiService } from "@/server/ai/service";
import type { Db } from "@/server/db/database";
import { createRagPipeline } from "@/server/rag/pipeline";
import type { FetchLike } from "@/services/ai-client";
import { GEMINI_KEY, GROQ_KEY, startFakeGemini, startFakeGroq, type Fake } from "../ai-fakes";

export interface Backend {
  service: AiService;
  gemini: Fake;
  groq: Fake;
  /** Sets the time the AI service sees (controls rate-limit cooldowns). */
  setNow(ms: number): void;
  /** In-process `fetch` for the browser client. */
  fetch: FetchLike;
  /** Handler for a Node HTTP server (browser tests): serves /api/ai/*. */
  http(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Saves both keys (and optionally a default). */
  configure(defaults?: { provider: "gemini" | "groq"; model: string }): Promise<void>;
  /** Back to a clean state: no saved keys, default replies, nothing queued. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface BackendOptions {
  /** A documentation database: enables the documentation search (Step 7) in /api/ai/chat and /api/docs/context. */
  docsDb?: Db;
}

export async function startBackend(options: BackendOptions = {}): Promise<Backend> {
  const docsDb = options.docsDb;
  const rag = docsDb ? createRagPipeline(() => docsDb) : undefined;
  const [gemini, groq] = await Promise.all([startFakeGemini(), startFakeGroq()]);
  const dir = mkdtempSync(join(tmpdir(), "gtps-backend-"));
  let now = Date.now();
  let useFakeClock = false;
  const service = new AiService({
    store: new AiConfigStore(join(dir, "ai-config.json"), {}),
    providers: { gemini: createGeminiProvider(gemini.baseUrl), groq: createGroqProvider(groq.baseUrl) },
    now: () => (useFakeClock ? now : Date.now()),
    sleep: async () => {},
    timeoutMs: 3000,
    streamIdleMs: 3000,
    retryBackoffMs: 5,
  });

  const route = (request: Request): Promise<Response> | Response => {
    switch (new URL(request.url).pathname) {
      case "/api/ai/settings": return handleGetSettings(service)(request);
      case "/api/ai/config": return request.method === "DELETE" ? handleRemoveConfig(service)(request) : handleSaveConfig(service)(request);
      case "/api/ai/models": return handleModels(service)(request);
      case "/api/ai/test": return handleTest(service)(request);
      case "/api/ai/chat": return handleChat(service, rag)(request);
      case "/api/docs/context": return rag ? Response.json(rag.status()) : new Response("{}", { status: 404 });
      default: return new Response("{}", { status: 404 });
    }
  };

  const inProcess: FetchLike = async (path, init = {}) => {
    const method = init.method ?? "GET";
    const request = new Request(`http://localhost:3000${path}`, {
      method,
      headers: { host: "localhost:3000", ...(init.headers as Record<string, string> | undefined) },
      body: typeof init.body === "string" ? init.body : null,
      signal: init.signal ?? undefined,
    });
    return route(request);
  };

  return {
    service,
    gemini,
    groq,
    setNow(ms) {
      useFakeClock = true;
      now = ms;
    },
    fetch: inProcess,
    async http(req, res) {
      if (!req.url?.startsWith("/api/ai/") && !req.url?.startsWith("/api/docs/context")) return false;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const hasBody = !["GET", "HEAD", "DELETE"].includes(req.method ?? "GET");
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const response = await route(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : null, signal: abort.signal }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } catch {
          // client went away
        }
      }
      res.end();
      return true;
    },
    async configure(defaults) {
      await service.saveConfig({ keys: { gemini: GEMINI_KEY, groq: GROQ_KEY }, ...(defaults ? { defaults } : {}) });
    },
    async reset() {
      service.removeConfig("all");
      for (const f of [gemini, groq]) {
        f.setReply(["Hel", "lo ", "wörld ✓"]);
        assert.equal(f.pending(), 0, "an override was queued but never used");
        f.requests.length = 0;
      }
      useFakeClock = false;
    },
    async close() {
      await Promise.all([gemini.close(), groq.close()]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The messages the fake Groq received in its last chat request. */
export const lastGroqMessages = (groq: Fake): Array<{ role: string; content: string }> => {
  const calls = groq.requests.filter((r) => r.url === "/chat/completions");
  return JSON.parse(calls.at(-1)!.body).messages;
};

/** The system instruction and contents the fake Gemini received in its last chat request. */
export const lastGeminiRequest = (gemini: Fake): { system: string; contents: Array<{ role: string; text: string }> } => {
  const calls = gemini.requests.filter((r) => r.url.includes(":streamGenerateContent"));
  const body = JSON.parse(calls.at(-1)!.body) as { systemInstruction?: { parts: Array<{ text: string }> }; contents: Array<{ role: string; parts: Array<{ text: string }> }> };
  return { system: body.systemInstruction?.parts.map((p) => p.text).join("") ?? "", contents: body.contents.map((c) => ({ role: c.role, text: c.parts.map((p) => p.text).join("") })) };
};
