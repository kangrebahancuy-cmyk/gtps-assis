import { protectedRoute } from "@/server/hosting";
import { handleLuaCheck } from "@/server/ai/api";
import { getRagPipeline } from "@/server/rag/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Checks a Lua script against the indexed documentation (syntax, API names, parameters, events). */
export const POST = protectedRoute((request: Request) => handleLuaCheck(getRagPipeline())(request));
