import type { NextRequest } from "next/server";

import { searchDocs } from "@/server/docs/explorer";
import { handle } from "@/server/docs/http";
import { SEARCH_SCOPES, type SearchScope } from "@/types/docs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/docs/search?q=chat&scope=all|title|keyword|api|function|code&limit=30 */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const raw = params.get("scope") ?? "all";
  const scope: SearchScope = (SEARCH_SCOPES as readonly string[]).includes(raw) ? (raw as SearchScope) : "all";
  const limit = Number(params.get("limit") ?? 30) || 30;
  return handle((db) => searchDocs(db, params.get("q") ?? "", scope, limit));
}
