import { NextResponse } from "next/server";

import { getStatus } from "@/server/scraper/job-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getStatus());
}
