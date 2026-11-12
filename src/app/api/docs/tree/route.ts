import { createConfig } from "@/server/scraper/config";
import { getDocTree } from "@/server/docs/explorer";
import { handle } from "@/server/docs/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return handle((db) => getDocTree(db, createConfig().pathPrefix));
}
