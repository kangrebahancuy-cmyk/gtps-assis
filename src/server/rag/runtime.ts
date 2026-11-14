import { getDatabase } from "@/server/db/database";
import { createRagPipeline, type RagPipeline } from "@/server/rag/pipeline";

const globalForRag = globalThis as unknown as { __gtpsRag?: RagPipeline };

/** One pipeline per server process, reading the shared SQLite connection. */
export function getRagPipeline(): RagPipeline {
  globalForRag.__gtpsRag ??= createRagPipeline(getDatabase);
  return globalForRag.__gtpsRag;
}
