import { NextResponse } from "next/server";
import { startBackgroundServices } from "@/server/sync/runtime";
import type { SyncRequestMode } from "@/types/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MODES: readonly SyncRequestMode[] = ["auto", "full", "incremental", "retry"];
const MESSAGES = {
  "already-running": "A synchronization is already in progress.",
  "nothing-to-retry": "There are no failed documents to retry.",
} as const;

export async function POST(request: Request) {
  let mode: SyncRequestMode = "auto";
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && "mode" in body) {
      const value = (body as { mode: unknown }).mode;
      if (typeof value !== "string" || !MODES.includes(value as SyncRequestMode)) {
        return NextResponse.json({ error: "mode must be auto, full, incremental or retry" }, { status: 400 });
      }
      mode = value as SyncRequestMode;
    }
  } catch {
    /* empty body: default to "auto" */
  }
  const result = startBackgroundServices().service.start(mode, "manual");
  if (!result.ok) return NextResponse.json({ error: MESSAGES[result.reason] }, { status: 409 });
  return NextResponse.json({ started: true, runId: result.runId, mode: result.mode }, { status: 202 });
}
