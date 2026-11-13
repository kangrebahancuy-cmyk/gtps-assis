import { handleRemoveConfig, handleSaveConfig } from "@/server/ai/api";
import { getAiService } from "@/server/ai/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = (request: Request) => handleSaveConfig(getAiService())(request);
export const DELETE = (request: Request) => handleRemoveConfig(getAiService())(request);
