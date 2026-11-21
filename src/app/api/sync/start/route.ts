import { protectedRoute } from "@/server/hosting";
import { handleSyncStart } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = protectedRoute((request: Request) => handleSyncStart(getSyncApiDeps())(request));
