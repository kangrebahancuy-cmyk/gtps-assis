import { handleTest } from "@/server/ai/api";
import { getAiService } from "@/server/ai/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleTest(getAiService())(request);
