import type { NextRequest } from "next/server";

import { API_KINDS } from "@/server/docs/classify";
import { listApi } from "@/server/docs/explorer";
import { handle } from "@/server/docs/http";
import type { ApiKind } from "@/types/docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/docs/api?kind=function|method|callback|event (kind optional) */
export function GET(request: NextRequest) {
  const kind = request.nextUrl.searchParams.get("kind");
  const valid = kind && (API_KINDS as readonly string[]).includes(kind) ? (kind as ApiKind) : undefined;
  return handle((db) => ({ entries: listApi(db, valid) }));
}
