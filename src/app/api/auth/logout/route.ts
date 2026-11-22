import { handleLogout } from "@/server/auth-api";
import { protectedRoute } from "@/server/hosting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = protectedRoute((request: Request) => handleLogout()(request));
