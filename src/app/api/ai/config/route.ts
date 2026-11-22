import { protectedRoute } from "@/server/hosting";
import { handleRemoveConfig, handleSaveConfig } from "@/server/ai/api";
import { withAiService } from "@/server/ai/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const PUT = protectedRoute((request: Request) => withAiService(request, (service) => handleSaveConfig(service)));
export const DELETE = protectedRoute((request: Request) => withAiService(request, (service) => handleRemoveConfig(service)));
