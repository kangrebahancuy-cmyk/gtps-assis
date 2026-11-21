import { hostedApiResponse } from "@/server/hosting";

/**
 * On a hosting service (see src/server/hosting.ts) every /api route except /api/health answers 503 with an
 * explanation, before any route code runs. Locally this does nothing.
 *
 * Returning nothing lets the request continue.
 */
export function middleware(request: Request): Response | undefined {
  return hostedApiResponse(request);
}

export const config = { matcher: ["/api/:path*"] };
