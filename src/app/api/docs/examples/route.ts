import { protectedRoute } from "@/server/hosting";
import type { NextRequest } from "next/server";

import { listExamples } from "@/server/docs/explorer";
import { handle } from "@/server/docs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/docs/examples?language=lua (language optional) */
export const GET = protectedRoute((request: NextRequest) => {
  const language = request.nextUrl.searchParams.get("language") ?? undefined;
  return handle((db) => ({ examples: listExamples(db, language || undefined) }));
});
