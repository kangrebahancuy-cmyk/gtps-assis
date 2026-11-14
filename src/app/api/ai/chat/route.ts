import { handleChat } from "@/server/ai/api";
import { getAiService } from "@/server/ai/runtime";
import { getRagPipeline } from "@/server/rag/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Streams a reply from the configured provider. The browser never sees the provider key. */
export const POST = (request: Request) => handleChat(getAiService(), getRagPipeline())(request);
