import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";
import { SettingsError } from "@/server/sync/scheduler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(startBackgroundServices().scheduler.getSettings());
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return NextResponse.json({ error: "Body must be an object." }, { status: 400 });
  }
  const { autoEnabled, intervalMinutes, schedulePaused } = body as Record<string, unknown>;
  try {
    const settings = startBackgroundServices().scheduler.updateSettings({
      ...(autoEnabled !== undefined && { autoEnabled: autoEnabled as boolean }),
      ...(intervalMinutes !== undefined && { intervalMinutes: intervalMinutes as number }),
      ...(schedulePaused !== undefined && { schedulePaused: schedulePaused as boolean }),
    });
    return NextResponse.json(settings);
  } catch (error) {
    if (error instanceof SettingsError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
