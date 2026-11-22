/** Browser side of the access password used on hosted deployments (see src/server/access.ts). */

export interface AuthStatus {
  hosted: boolean;
  configured: boolean;
  authenticated: boolean;
}

export interface AuthClient {
  status(): Promise<AuthStatus>;
  login(password: string): Promise<AuthStatus>;
  logout(): Promise<void>;
}

export function createAuthClient(fetchImpl: typeof fetch = (...args) => fetch(...args)): AuthClient {
  return {
    async status() {
      const res = await fetchImpl("/api/auth/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as AuthStatus;
    },
    async login(password) {
      const res = await fetchImpl("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
      const body = (await res.json().catch(() => null)) as (Partial<AuthStatus> & { error?: string }) | null;
      if (!res.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${res.status}`);
      return body as AuthStatus;
    },
    async logout() {
      await fetchImpl("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    },
  };
}
