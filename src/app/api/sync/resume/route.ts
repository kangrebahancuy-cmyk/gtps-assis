import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  if (!startBackgroundServices().service.resume()) {
    return NextResponse.json({ error: "No paused synchronization to resume." }, { status: 409 });
  }
  return NextResponse.json({ resumed: true }, { status: 202 });
}
