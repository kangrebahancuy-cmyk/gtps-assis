import { protectedRoute } from "@/server/hosting";
import { getDocsStatus } from "@/server/docs/explorer";
import { handle } from "@/server/docs/http";
import { getFullStatus } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute(() => {
  const { state, current } = getFullStatus();
  return handle((db) => getDocsStatus(db, { state, current }));
});
