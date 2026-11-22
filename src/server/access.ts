import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Access control for a copy that runs on a hosting service. Its address is public, and the backend can spend the
 * owner's provider keys, so the backend is locked until GTPS_ACCESS_PASSWORD is set and the visitor has entered it.
 * The session is stateless (an HMAC of the password), so it works across serverless instances; changing the
 * password signs everyone out.
 */

export const SESSION_COOKIE = "gtps_session";
export const MIN_PASSWORD_LENGTH = 8;
const SESSION_SECONDS = 60 * 60 * 24 * 14;

type Env = Record<string, string | undefined>;

/** The configured password, or null when unset or too short to be safe. */
export function accessPassword(env: Env = process.env): string | null {
  const value = (env.GTPS_ACCESS_PASSWORD ?? "").trim();
  return value.length >= MIN_PASSWORD_LENGTH ? value : null;
}

const digest = (secret: string, label: string): Buffer => createHmac("sha256", secret).update(label).digest();

export function sessionToken(password: string): string {
  return digest(password, "gtps-assistant-session-v1").toString("hex");
}

/** Constant-time comparison (both sides are hashed first so lengths never leak). */
export function passwordMatches(input: string, password: string): boolean {
  return timingSafeEqual(digest(input, "gtps-assistant-login"), digest(password, "gtps-assistant-login"));
}

export function hasValidSession(request: Request, password: string): boolean {
  const header = request.headers.get("cookie") ?? "";
  const expected = Buffer.from(sessionToken(password));
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== SESSION_COOKIE) continue;
    const given = Buffer.from(rest.join("="));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true;
  }
  return false;
}

export function sessionCookie(password: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${sessionToken(password)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
