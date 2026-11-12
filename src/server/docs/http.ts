import { NextResponse } from "next/server";

import { getDatabase, type Db } from "@/server/db/database";

/** Shared plumbing for the read-only /api/docs/* routes. */
export function handle(fn: (db: Db) => unknown): NextResponse {
  try {
    return NextResponse.json(fn(getDatabase()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const notFound = (what: string): NextResponse => NextResponse.json({ error: `${what} not found` }, { status: 404 });
