import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  if (!startBackgroundServices().service.cancel()) {
    return NextResponse.json({ error: "No synchronization is in progress." }, { status: 409 });
  }
  return NextResponse.json({ cancelling: true }, { status: 202 });
}
