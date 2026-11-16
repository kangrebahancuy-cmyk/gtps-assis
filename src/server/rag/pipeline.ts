import type { Db } from "@/server/db/database";
import { buildPrompt } from "@/server/rag/prompt";
import { indexState, retrieve, type RetrieveOptions, type Retrieval } from "@/server/rag/retrieve";
import { detectIntent } from "@/server/rag/intent";
import { prepareGeneration } from "@/server/lua/generate";
import { verifyScript } from "@/server/lua/verify";
import type { ChatRequest } from "@/types/ai";
import type { ScriptCheck } from "@/types/lua";
import type { DocsContextStatus, RetrievalInfo } from "@/types/rag";

/**
 * The documentation workflow for one chat request:
 *   question -> intent detection -> documentation search -> section retrieval
 *   -> context ranking -> prompt for Gemini or Groq (the caller streams the answer)
 *   -> citations (returned as `context`, shown next to the answer).
 */

export interface PreparedRequest {
  /** The request to send to the provider (system prompt and documentation included). */
  request: ChatRequest;
  /** What the search found; sent to the browser as the stream's `context` event. */
  context: RetrievalInfo;
  /** Generate mode: the script being modified, kept for the preservation check after the reply. */
  original?: string | null;
}

export interface RagPipeline {
  prepare(request: ChatRequest): PreparedRequest;
  /** Checks a script against the indexed documentation (syntax, API names, parameters, events, preservation). */
  check(code: string, original?: string | null): ScriptCheck;
  status(): DocsContextStatus;
}

const failed = (message: string, db: Db | null, question: string): Retrieval => {
  let index: RetrievalInfo["index"] = { documents: 0, chunks: 0, lastSyncAt: null };
  try {
    if (db) index = indexState(db);
  } catch {
    /* keep zeros: the index itself is what failed */
  }
  const intent = detectIntent(question);
  return {
    intent,
    chunks: [],
    info: {
      status: "error", reason: message, intent: intent.kind, terms: intent.terms, candidates: 0, documentsRetrieved: 0, sectionsSent: 0,
      tokensEstimate: 0, removedInstructionLines: 0, citations: [], identifiers: [], conflicts: [], index,
    },
  };
};

export function createRagPipeline(getDb: () => Db, options: RetrieveOptions = {}): RagPipeline {
  return {
    check(code, original) {
      return verifyScript(getDb(), code, { original });
    },
    prepare(request) {
      if (request.mode === "generate") {
        try {
          return prepareGeneration(getDb(), request);
        } catch (error) {
          // Generation must not run without documentation silently: the failure is reported in the context.
          const message = error instanceof Error ? error.message : "The documentation search failed.";
          const failure = failed(message, null, request.messages[request.messages.length - 1]?.content ?? "");
          const { docs: _d, mode: _m, ...rest } = request;
          void _d;
          void _m;
          return { request: { ...rest, messages: buildPrompt(request.messages, failure).messages }, context: failure.info, original: null };
        }
      }
      let db: Db | null = null;
      let retrieval: Retrieval;
      try {
        db = getDb();
        retrieval = retrieve(db, request.messages, options);
      } catch (error) {
        // A broken index must never break the chat: the model is told that it has no documentation.
        const lastUser = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
        retrieval = failed(error instanceof Error ? error.message : "The documentation search failed.", db, lastUser);
      }
      const prompt = buildPrompt(request.messages, retrieval);
      const { docs: _docs, ...rest } = request;
      void _docs;
      return { request: { ...rest, messages: prompt.messages }, context: retrieval.info };
    },
    status() {
      const index = indexState(getDb());
      return { available: index.chunks > 0, documents: index.documents, chunks: index.chunks, lastSyncAt: index.lastSyncAt };
    },
  };
}
