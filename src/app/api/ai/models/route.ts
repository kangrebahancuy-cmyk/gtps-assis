import { protectedRoute } from "@/server/hosting";
import { handleModels } from "@/server/ai/api";
import { getAiService } from "@/server/ai/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute((request: Request) => handleModels(getAiService())(request));
