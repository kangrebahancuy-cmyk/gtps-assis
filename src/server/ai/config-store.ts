import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { validateApiKey } from "@/server/ai/validate";
import { isProviderId, PROVIDER_IDS, type AiDefaults, type ProviderId } from "@/types/ai";

interface StoredConfig {
  keys: Partial<Record<ProviderId, string>>;
  defaults: AiDefaults;
}

export const ENV_KEY_NAMES: Record<ProviderId, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
};

export interface ResolvedKey {
  key: string;
  source: "saved" | "environment";
}

const EMPTY = (): StoredConfig => ({ keys: {}, defaults: { provider: null, model: null } });

/**
 * Provider keys and the default provider/model, kept in a local JSON file that
 * is gitignored and created with owner-only permissions. A key saved here wins
 * over one from the environment (GEMINI_API_KEY / GROQ_API_KEY). The file is
 * plaintext: it protects against accidental commits and other local users,
 * not against someone who can read your files as you.
 */
export class AiConfigStore {
  constructor(
    private readonly path: string,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private read(): StoredConfig {
    if (!existsSync(this.path)) return EMPTY();
    try {
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      const config = EMPTY();
      if (typeof raw === "object" && raw !== null) {
        const { keys, defaults } = raw as { keys?: Record<string, unknown>; defaults?: Record<string, unknown> };
        for (const id of PROVIDER_IDS) {
          const value = keys?.[id];
          if (typeof value === "string") {
            try {
              config.keys[id] = validateApiKey(value);
            } catch {
              // ignore an unusable stored key
            }
          }
        }
        if (isProviderId(defaults?.provider) && typeof defaults?.model === "string") {
          config.defaults = { provider: defaults.provider, model: defaults.model };
        }
      }
      return config;
    } catch {
      // Unreadable file: keep a copy for the user and start clean instead of failing every request.
      try {
        copyFileSync(this.path, `${this.path}.corrupt`);
      } catch {
        // best effort
      }
      return EMPTY();
    }
  }

  private write(config: StoredConfig): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(temp, 0o600);
    } catch {
      // not supported on every platform
    }
    renameSync(temp, this.path);
  }

  resolveKey(provider: ProviderId): ResolvedKey | null {
    const saved = this.read().keys[provider];
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
    return this.read().defaults;
  }

  setKey(provider: ProviderId, key: string): void {
    const config = this.read();
    config.keys[provider] = validateApiKey(key);
    this.write(config);
  }

  /** Removes the saved key (an environment key, if any, stays) and clears the defaults when they pointed at this provider. */
  removeKey(provider: ProviderId): void {
    const config = this.read();
    delete config.keys[provider];
    if (config.defaults.provider === provider) config.defaults = { provider: null, model: null };
    this.write(config);
  }

  setDefaults(defaults: AiDefaults): void {
    const config = this.read();
    config.defaults = defaults;
    this.write(config);
  }
}
