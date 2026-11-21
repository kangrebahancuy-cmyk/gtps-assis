import { protectedRoute } from "@/server/hosting";
import { handleSyncStatus } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute((request: Request) => handleSyncStatus(getSyncApiDeps())(request));
