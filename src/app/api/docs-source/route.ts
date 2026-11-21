import { protectedRoute } from "@/server/hosting";
import { handleGetDocsSource, handlePutDocsSource } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute((request: Request) => handleGetDocsSource(getSyncApiDeps())(request));
export const PUT = protectedRoute((request: Request) => handlePutDocsSource(getSyncApiDeps())(request));
