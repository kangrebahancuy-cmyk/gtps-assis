import { NextResponse } from "next/server";

import { getDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ documents: new Repository(getDatabase()).listDocuments() });
}
