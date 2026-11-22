import { accessPassword } from "@/server/access";
import { AiConfigStore } from "@/server/ai/config-store";
import { CookieConfigStore } from "@/server/ai/cookie-store";
import { AiService } from "@/server/ai/service";
import { hostedPlatform } from "@/server/platform";
import { getAiConfigPath } from "@/server/scraper/config";

const globalForAi = globalThis as unknown as { __gtpsAiService?: AiService };

/** One AiService per server process (kept across dev hot reloads). Local use only: on a host see withAiService. */
export function getAiService(): AiService {
  globalForAi.__gtpsAiService ??= new AiService({ store: new AiConfigStore(getAiConfigPath()) });
  return globalForAi.__gtpsAiService;
}

/**
 * Runs an /api/ai handler with the right AiService. Locally that is the process-wide one (keys in data/ai-config.json).
 * On a hosting service keys live in the visitor's encrypted cookie (see cookie-store.ts), so each request gets its own
 * service built from its own cookie, and a changed configuration is written back as a Set-Cookie on the response.
 */
export async function withAiService(
  request: Request,
  handler: (service: AiService) => (request: Request) => Promise<Response>,
  env: Record<string, string | undefined> = process.env,
): Promise<Response> {
  const password = hostedPlatform(env) === null ? null : accessPassword(env);
  if (password === null) return handler(getAiService())(request);
  const store = new CookieConfigStore(request, password, env);
  const response = await handler(new AiService({ store }))(request);
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const cookie = store.setCookieHeader(secure);
  if (cookie === null) return response;
  const headers = new Headers(response.headers);
  headers.append("set-cookie", cookie);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
