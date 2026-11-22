import { assertLocalRequest } from "@/server/ai/guard";
import { AiError, redactSecrets } from "@/server/ai/errors";
import { BACKEND_UNAVAILABLE, HOSTED_MESSAGE, STORAGE_MESSAGE, STORAGE_UNAVAILABLE } from "@/lib/hosting";

/**
 * The backend keeps API keys, a SQLite file and a background scheduler, so it is meant to run as one long-lived
 * process on the user's computer. Serverless hosts (read-only disk, no background work, a public address that
 * anyone could call) cannot host it safely, so on those the API answers "unavailable" instead of crashing.
 */

const HOST_MARKERS: readonly [string, string][] = [
  ["VERCEL", "Vercel"],
  ["NETLIFY", "Netlify"],
  ["AWS_LAMBDA_FUNCTION_NAME", "AWS Lambda"],
  ["K_SERVICE", "Cloud Run"],
  ["GTPS_HOSTED", "a hosting service"],
];

/** The name of the hosting platform when this process runs on one, otherwise null. */
export function hostedPlatform(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const [name, label] of HOST_MARKERS) {
    const value = env[name];
    if (value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false") return label;
  }
  return null;
}

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

/** Answers every /api request except /api/health on a hosting service; undefined means "carry on". */
export function hostedApiResponse(request: Request, env: NodeJS.ProcessEnv = process.env): Response | undefined {
  if (hostedPlatform(env) === null) return undefined;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return undefined;
  }
  if (!pathname.startsWith("/api/") || pathname === "/api/health") return undefined;
  return errorResponse(request, 503, BACKEND_UNAVAILABLE, HOSTED_MESSAGE);
}

/** Errors from opening the database or the data folder. They say what failed without exposing paths. */
export function isStorageFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && /^(EROFS|EACCES|EPERM|ENOENT|ENOSPC|EMFILE|EISDIR|ENOTDIR|ERR_SQLITE_ERROR)$/.test(code)) return true;
  return /node:sqlite is unavailable|unable to open database|database is locked|disk I\/O error|readonly database|malformed/i.test(error.message);
}

export interface ProtectedOptions {
  env?: NodeJS.ProcessEnv;
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
