import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getDatabase } from "@/server/db/database";
import { getDocument } from "@/server/docs/explorer";
import { notFound } from "@/server/docs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/docs/document?id=12  or  ?url=https://… */
export function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = Number(params.get("id"));
  const url = params.get("url");
  if (!Number.isInteger(id) && !url) {
    return NextResponse.json({ error: "Pass ?id= or ?url=" }, { status: 400 });
  }
  const db = getDatabase();
  const doc = url ? getDocument(db, { url }) : getDocument(db, { id });
  return doc ? NextResponse.json(doc) : notFound("Document");
}
