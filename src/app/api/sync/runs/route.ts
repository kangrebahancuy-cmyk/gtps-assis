import { protectedRoute } from "@/server/hosting";
import { handleSyncRuns } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute((request: Request) => handleSyncRuns(getSyncApiDeps())(request));
