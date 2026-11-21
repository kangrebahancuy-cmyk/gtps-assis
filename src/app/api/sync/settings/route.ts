import { protectedRoute } from "@/server/hosting";
import { handleGetSyncSettings, handlePutSyncSettings } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute((request: Request) => handleGetSyncSettings(getSyncApiDeps())(request));
export const PUT = protectedRoute((request: Request) => handlePutSyncSettings(getSyncApiDeps())(request));
