import { handleGetSyncSettings, handlePutSyncSettings } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handleGetSyncSettings(getSyncApiDeps())(request);
export const PUT = (request: Request) => handlePutSyncSettings(getSyncApiDeps())(request);
