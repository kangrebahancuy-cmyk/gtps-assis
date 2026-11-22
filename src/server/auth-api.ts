import { accessPassword, clearedSessionCookie, hasValidSession, passwordMatches, sessionCookie } from "@/server/access";
import { errorResponse } from "@/server/hosting";
import { hostedPlatform } from "@/server/platform";

export interface AuthStatus {
  /** True on a hosting service, where the backend needs the access password. */
  hosted: boolean;
  /** The owner set GTPS_ACCESS_PASSWORD (hosted only). */
  configured: boolean;
  authenticated: boolean;
}

type Env = Record<string, string | undefined>;

const noStore = { "cache-control": "no-store" };

export function authStatus(request: Request, env: Env = process.env): AuthStatus {
  if (hostedPlatform(env) === null) return { hosted: false, configured: true, authenticated: true };
  const password = accessPassword(env);
  return { hosted: true, configured: password !== null, authenticated: password !== null && hasValidSession(request, password) };
}

/** Failed logins per client in this instance: five wrong passwords lock that client out for ten minutes. */
const failures = new Map<string, { count: number; first: number }>();
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;

const clientOf = (request: Request): string => (request.headers.get("x-forwarded-for") ?? "unknown").split(",")[0]?.trim() || "unknown";

export function resetLoginLimiter(): void {
  failures.clear();
}

export const handleAuthStatus = (env: Env = process.env) => async (request: Request): Promise<Response> =>
  Response.json(authStatus(request, env), { headers: noStore });

export const handleLogin = (env: Env = process.env, now: () => number = Date.now) => async (request: Request): Promise<Response> => {
  if (hostedPlatform(env) === null) return errorResponse(request, 400, "not_hosted", "There is no password on a local copy.");
  const password = accessPassword(env);
  if (password === null) return errorResponse(request, 503, "backend_unavailable", "No access password is configured on this deployment (GTPS_ACCESS_PASSWORD).");

  const client = clientOf(request);
  const record = failures.get(client);
  if (record && now() - record.first > WINDOW_MS) failures.delete(client);
  if ((failures.get(client)?.count ?? 0) >= MAX_FAILURES) {
    return errorResponse(request, 429, "too_many_attempts", "Too many wrong passwords. Try again in ten minutes.");
  }

  let supplied = "";
  try {
    const body = (await request.json()) as { password?: unknown };
    if (typeof body.password === "string" && body.password.length <= 256) supplied = body.password;
  } catch {
    return errorResponse(request, 400, "bad_request", "Send JSON: { \"password\": \"...\" }.");
  }
  if (!passwordMatches(supplied, password)) {
    const current = failures.get(client);
    failures.set(client, { count: (current?.count ?? 0) + 1, first: current?.first ?? now() });
    return errorResponse(request, 401, "wrong_password", "Wrong password.");
  }
  failures.delete(client);
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return Response.json({ hosted: true, configured: true, authenticated: true } satisfies AuthStatus, {
    headers: { ...noStore, "set-cookie": sessionCookie(password, secure) },
  });
};

export const handleLogout = (env: Env = process.env) => async (request: Request): Promise<Response> => {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  void env;
  return Response.json({ ok: true }, { headers: { ...noStore, "set-cookie": clearedSessionCookie(secure) } });
};
