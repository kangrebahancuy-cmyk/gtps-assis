import { AiError } from "@/server/ai/errors";
import { hostedPlatform } from "@/server/platform";

/**
 * Protects the local AI endpoints from other websites. A page you visit can
 * make your browser call http://localhost; these checks make sure only this
 * app (same origin, a localhost hostname) is accepted.
 */

const DEFAULT_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function allowedHosts(env: Record<string, string | undefined>): string[] {
  const extra = (env.GTPS_ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...DEFAULT_HOSTS, ...extra];
}

export function assertLocalRequest(request: Request, options: { mutation: boolean; env?: Record<string, string | undefined> } = { mutation: false }): void {
  const env = options.env ?? process.env;
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0] ?? "";
  // On a hosting service the host name is the deployment's own; the access cookie (SameSite=Strict) and the Origin check below protect it.
  if (hostedPlatform(env) === null && !allowedHosts(env).includes(hostname)) {
    // Stops DNS-rebinding: a hostile domain pointing at 127.0.0.1 still carries its own Host header.
    throw new AiError("invalid_input", "This endpoint only answers requests addressed to localhost. Set GTPS_ALLOWED_HOSTS to allow another host name.");
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new AiError("invalid_input", "Cross-site requests are not allowed.");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "null") {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      throw new AiError("invalid_input", "Invalid Origin header.");
    }
    if (originHost !== host) throw new AiError("invalid_input", "Cross-origin requests are not allowed.");
  } else if (origin === "null") {
    throw new AiError("invalid_input", "Requests from opaque origins are not allowed.");
  }
  if (options.mutation && !(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new AiError("invalid_input", "Send JSON with Content-Type: application/json.");
  }
}
