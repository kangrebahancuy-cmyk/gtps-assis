import { protectedRoute } from "@/server/hosting";
import { handle } from "@/server/docs/http";
import { createRagPipeline } from "@/server/rag/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/docs/context: whether documentation search can be used, and how much is indexed (read from the database). */
export const GET = protectedRoute(() => {
  return handle((db) => createRagPipeline(() => db).status());
});
