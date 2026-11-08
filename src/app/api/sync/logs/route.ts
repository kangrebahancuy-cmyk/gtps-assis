import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit") ?? "200");
  const runId = params.get("runId");
  const logs = startBackgroundServices().repo.getLogs(Number.isFinite(limit) ? limit : 200, runId || null);
  return NextResponse.json({ logs });
}
