import { handleAddDomain, handleRemoveDomain } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (request: Request) => handleAddDomain(getSyncApiDeps())(request);
export const DELETE = (request: Request) => handleRemoveDomain(getSyncApiDeps())(request);
