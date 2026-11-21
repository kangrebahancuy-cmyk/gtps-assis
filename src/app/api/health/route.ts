import { getDatabase } from "@/server/db/database";
import { handleHealth } from "@/server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handleHealth({ openDatabase: getDatabase })(request);
