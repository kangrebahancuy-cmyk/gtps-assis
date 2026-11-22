import { protectedRoute } from "@/server/hosting";
import { handleTest } from "@/server/ai/api";
import { withAiService } from "@/server/ai/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = protectedRoute((request: Request) => withAiService(request, (service) => handleTest(service)));
