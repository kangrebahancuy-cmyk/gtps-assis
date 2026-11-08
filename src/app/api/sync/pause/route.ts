import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  if (!startBackgroundServices().service.pause()) {
    return NextResponse.json({ error: "No running synchronization to pause." }, { status: 409 });
  }
  return NextResponse.json({ paused: true }, { status: 202 });
}
