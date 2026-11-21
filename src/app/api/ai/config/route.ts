import { protectedRoute } from "@/server/hosting";
import { handleRemoveConfig, handleSaveConfig } from "@/server/ai/api";
import { getAiService } from "@/server/ai/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = protectedRoute((request: Request) => handleSaveConfig(getAiService())(request));
export const DELETE = protectedRoute((request: Request) => handleRemoveConfig(getAiService())(request));
