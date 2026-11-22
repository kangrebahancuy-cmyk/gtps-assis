import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

import { ENV_KEY_NAMES, type ConfigStore, type ResolvedKey } from "@/server/ai/config-store";
import { validateApiKey } from "@/server/ai/validate";
import { isProviderId, PROVIDER_IDS, type AiDefaults, type ProviderId } from "@/types/ai";

/**
 * Where provider keys live on a hosting service, which has no writable disk that lasts and no shared storage: in an
 * encrypted cookie of the visitor's own browser.
 *
 * - The cookie is HttpOnly, so page scripts never see a key; the browser only sends it back to this site.
 * - It is encrypted (AES-256-GCM) with a key derived from GTPS_ACCESS_PASSWORD, so it is unreadable and unforgeable
 *   without the password, and a cookie made under another password is simply ignored.
 * - The keys therefore exist per browser: adding one here does not add it on another device.
 * An environment variable (GEMINI_API_KEY / GROQ_API_KEY) still works as a fallback for every visitor.
 */

export const AI_COOKIE = "gtps_ai";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

interface Stored {
  keys: Partial<Record<ProviderId, string>>;
  defaults: AiDefaults;
}

const empty = (): Stored => ({ keys: {}, defaults: { provider: null, model: null } });
const cipherKey = (password: string): Buffer => createHmac("sha256", password).update("gtps-assistant-ai-cookie-v1").digest();

export function sealConfig(config: Stored, password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(password), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(config), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** The stored configuration, or an empty one when the cookie is missing, damaged or made under another password. */
export function openConfig(value: string | undefined, password: string): Stored {
  if (!value) return empty();
  try {
    const raw = Buffer.from(value, "base64url");
    if (raw.length < 29) return empty();
    const decipher = createDecipheriv("aes-256-gcm", cipherKey(password), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const parsed: unknown = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    const out = empty();
    if (typeof parsed === "object" && parsed !== null) {
      const { keys, defaults } = parsed as { keys?: Record<string, unknown>; defaults?: Record<string, unknown> };
      for (const id of PROVIDER_IDS) {
        const key = keys?.[id];
        if (typeof key === "string") {
          try {
            out.keys[id] = validateApiKey(key);
          } catch {
            // unusable key: ignore
          }
        }
      }
      if (isProviderId(defaults?.provider) && typeof defaults?.model === "string") out.defaults = { provider: defaults.provider, model: defaults.model };
    }
    return out;
  } catch {
    return empty();
  }
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [n, ...rest] = part.trim().split("=");
    if (n === name) return rest.join("=");
  }
  return undefined;
}

export class CookieConfigStore implements ConfigStore {
  private config: Stored;
  private dirty = false;

  constructor(
    request: Request,
    private readonly password: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {
    this.config = openConfig(readCookie(request, AI_COOKIE), password);
  }

  resolveKey(provider: ProviderId): ResolvedKey | null {
    const saved = this.config.keys[provider];
    if (saved) return { key: saved, source: "saved" };
    const fromEnv = this.env[ENV_KEY_NAMES[provider]];
    if (fromEnv) {
      try {
        return { key: validateApiKey(fromEnv), source: "environment" };
      } catch {
        return null;
      }
    }
    return null;
  }

  getDefaults(): AiDefaults {
    return this.config.defaults;
  }

  setKey(provider: ProviderId, key: string): void {
    this.config.keys[provider] = validateApiKey(key);
    this.dirty = true;
  }

  removeKey(provider: ProviderId): void {
    delete this.config.keys[provider];
    if (this.config.defaults.provider === provider) this.config.defaults = { provider: null, model: null };
    this.dirty = true;
  }

  setDefaults(defaults: AiDefaults): void {
    this.config.defaults = defaults;
    this.dirty = true;
  }

  /** The Set-Cookie header to send when something changed, otherwise null. */
  setCookieHeader(secure: boolean): string | null {
    if (!this.dirty) return null;
    const empty = Object.keys(this.config.keys).length === 0 && this.config.defaults.provider === null;
    const flags = `Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
    if (empty) return `${AI_COOKIE}=; ${flags}; Max-Age=0`;
    return `${AI_COOKIE}=${sealConfig(this.config, this.password)}; ${flags}; Max-Age=${MAX_AGE_SECONDS}`;
  }
}
