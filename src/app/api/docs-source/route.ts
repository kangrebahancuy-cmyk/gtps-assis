import { handleGetDocsSource, handlePutDocsSource } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (request: Request) => handleGetDocsSource(getSyncApiDeps())(request);
export const PUT = (request: Request) => handlePutDocsSource(getSyncApiDeps())(request);
