import { NextResponse } from "next/server";

import { startScrape } from "@/server/scraper/job-manager";
import type { ScraperMode } from "@/types/scraper";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MESSAGES = {
  "already-running": "A scraping run is already in progress.",
  "nothing-to-retry": "There are no failed pages to retry.",
} as const;

export async function POST(request: Request) {
  let mode: ScraperMode = "full";
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && "mode" in body) {
      const value = (body as { mode: unknown }).mode;
      if (value === "retry" || value === "full") mode = value;
      else {
        return NextResponse.json({ error: "mode must be 'full' or 'retry'" }, { status: 400 });
      }
    }
  } catch {
    /* empty body: default to a full run */
  }

  const result = startScrape(mode);
  if (!result.ok) {
    return NextResponse.json({ error: MESSAGES[result.reason] }, { status: 409 });
  }
  return NextResponse.json({ started: true, mode }, { status: 202 });
}
