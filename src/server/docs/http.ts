import { getDatabase, type Db } from "@/server/db/database";

/**
 * Shared plumbing for the read-only /api/docs/* routes. Errors are not caught here: `protectedRoute`
 * turns them into a JSON error without the raw message (which can contain file paths).
 */
export function handle(fn: (db: Db) => unknown): Response {
  return Response.json(fn(getDatabase()), { headers: { "cache-control": "no-store" } });
}

export const notFound = (what: string): Response => Response.json({ error: `${what} not found` }, { status: 404 });
