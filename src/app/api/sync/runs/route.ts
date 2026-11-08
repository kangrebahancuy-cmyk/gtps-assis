import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ runs: startBackgroundServices().repo.listRuns(20) });
}
