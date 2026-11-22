import { handleAuthStatus } from "@/server/auth-api";
import { protectedRoute } from "@/server/hosting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = protectedRoute((request: Request) => handleAuthStatus()(request));
