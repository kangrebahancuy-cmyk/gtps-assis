import { protectedRoute } from "@/server/hosting";
import { handleChat } from "@/server/ai/api";
import { withAiService } from "@/server/ai/runtime";
import { getRagPipeline } from "@/server/rag/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60; // streaming answers on a serverless host (60 s is allowed on every plan)

/** Streams a reply from the configured provider. The browser never sees the provider key. */
export const POST = protectedRoute((request: Request) => withAiService(request, (service) => handleChat(service, getRagPipeline())));
