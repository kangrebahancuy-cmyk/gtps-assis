import { NextResponse } from "next/server";
import { getFullStatus } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getFullStatus());
}
