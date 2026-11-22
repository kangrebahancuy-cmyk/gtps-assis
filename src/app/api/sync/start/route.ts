import { protectedRoute } from "@/server/hosting";
import { hostedPlatform } from "@/server/platform";
import { handleSyncStart } from "@/server/sync/api";
import { getSyncApiDeps } from "@/server/sync/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// On a serverless host the crawl runs after the response is sent and must finish inside this limit (60 s is allowed on every plan).
export const maxDuration = 60;

export const POST = protectedRoute(async (request: Request) => {
  const deps = getSyncApiDeps();
  const response = await handleSyncStart(deps)(request);
  // A serverless function is frozen once the response is sent unless it is told to keep working.
  if (response.status === 202 && hostedPlatform() !== null) {
    const { after } = await import("next/server");
    after(() => deps.service.whenIdle());
  }
  return response;
});
