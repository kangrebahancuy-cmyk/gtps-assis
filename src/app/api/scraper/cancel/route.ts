import { NextResponse } from "next/server";

import { cancelScrape } from "@/server/scraper/job-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST() {
  if (!cancelScrape()) {
    return NextResponse.json({ error: "No scraping run is in progress." }, { status: 409 });
  }
  return NextResponse.json({ cancelling: true }, { status: 202 });
}
