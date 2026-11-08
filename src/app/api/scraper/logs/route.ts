import { NextResponse } from "next/server";

import { getDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const raw = Number(new URL(request.url).searchParams.get("limit") ?? "200");
  const limit = Number.isFinite(raw) ? raw : 200;
  return NextResponse.json({ logs: new Repository(getDatabase()).getLogs(limit) });
}
