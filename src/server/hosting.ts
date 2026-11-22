import { accessPassword, hasValidSession } from "@/server/access";
import { assertLocalRequest } from "@/server/ai/guard";
import { hostedPlatform } from "@/server/platform";
import { AiError, redactSecrets } from "@/server/ai/errors";
import { AUTH_REQUIRED, AUTH_REQUIRED_MESSAGE, BACKEND_UNAVAILABLE, HOSTED_NEEDS_PASSWORD, STORAGE_MESSAGE, STORAGE_UNAVAILABLE } from "@/lib/hosting";

/**
 * The backend keeps API keys, a SQLite file and a background scheduler, so it is meant to run as one long-lived
 * process on the user's computer. Serverless hosts (read-only disk, no background work, a public address that
 * anyone could call) cannot host it safely, so on those the API answers "unavailable" instead of crashing.
 */

export { hostedPlatform };

/** The JSON shape depends on the client: /api/ai and /api/lua use { error: {kind,…} }, the rest { error: string, code }. */
function usesAiErrorShape(pathname: string): boolean {
  return pathname.startsWith("/api/ai/") || pathname.startsWith("/api/lua/");
}

export function errorResponse(request: Request, status: number, code: string, message: string): Response {
  let pathname = "";
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    // keep the plain shape
  }
  const body = usesAiErrorShape(pathname)
    ? { error: { kind: code === BACKEND_UNAVAILABLE || code === STORAGE_UNAVAILABLE ? "backend_unavailable" : "unknown", message, provider: null, status, retryable: false, retryAfterMs: null }, code }
    : { error: message, code };
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

/**
 * On a hosting service the backend works only for a visitor who entered GTPS_ACCESS_PASSWORD. Without that variable
 * it stays locked (503), because the address is public and the backend can spend the owner's provider keys.
 * /api/health and /api/auth/* are always reachable. undefined means "carry on".
 */
export function hostedApiResponse(request: Request, env: Record<string, string | undefined> = process.env): Response | undefined {
  if (hostedPlatform(env) === null) return undefined;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith("/api/") || pathname === "/api/health" || pathname.startsWith("/api/auth/")) return undefined;
  const password = accessPassword(env);
  if (password === null) return errorResponse(request, 503, BACKEND_UNAVAILABLE, HOSTED_NEEDS_PASSWORD);
  if (hasValidSession(request, password)) return undefined;
  return errorResponse(request, 401, AUTH_REQUIRED, AUTH_REQUIRED_MESSAGE);
}

export function isStorageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^(EROFS|EACCES|EPERM|ENOENT|ENOSPC|EMFILE|EISDIR|ENOTDIR|ERR_SQLITE_ERROR)$/.test(code)) return true;
  return /node:sqlite is unavailable|unable to open database|database is locked|disk I\/O error|readonly database|malformed/i.test(error.message);
}

export interface ProtectedOptions {
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

/**
 * Wraps a route handler so that every /api route behaves the same way:
 * 1. on a hosting service: 503 "unavailable" (never touches the disk);
 * 2. only requests addressed to this computer, from this app, are served (assertLocalRequest);
 * 3. the handler runs lazily (databases open only for a request that passed 1 and 2);
 * 4. a failure becomes a JSON error with no stack trace or file path, never an empty 500.
 */
export function protectedRoute<R extends Request>(handler: (request: R) => Response | Promise<Response>, options: ProtectedOptions = {}) {
  const log = options.log ?? ((message: string) => console.error(message));
  return async (request: R): Promise<Response> => {
    const env = options.env ?? process.env;
    const hosted = hostedApiResponse(request, env);
    if (hosted) return hosted;
    // Only requests that carry a body must be JSON; DELETE has none (the other checks still apply to it).
    const mutation = ["POST", "PUT", "PATCH"].includes(request.method.toUpperCase());
    try {
      assertLocalRequest(request, { mutation, env });
    } catch (error) {
      if (error instanceof AiError) return errorResponse(request, 403, "forbidden", error.message);
      return errorResponse(request, 403, "forbidden", "This request was refused.");
    }
    try {
      return await handler(request);
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      log(`[gtps-assistant] ${request.method} ${new URL(request.url).pathname} failed: ${detail}`);
      if (isStorageFailure(error)) return errorResponse(request, 503, STORAGE_UNAVAILABLE, STORAGE_MESSAGE);
      return errorResponse(request, 500, "internal", "Unexpected error in the local backend. Details are in the server log.");
    }
  };
}
