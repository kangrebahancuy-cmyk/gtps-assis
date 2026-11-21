import { handleSyncLogs } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handleSyncLogs(getSyncApiDeps())(request);
