"use client";

import { useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createAuthClient, type AuthStatus } from "@/services/auth-client";

const client = createAuthClient();

/**
 * Shown only on a hosting service. The backend (AI, sync, documentation search) is locked until the owner sets
 * GTPS_ACCESS_PASSWORD and the visitor enters it; the browser-only features never depend on this.
 * On a local copy it renders nothing.
 */
export function AccessBanner() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    client.status().then((s) => alive && setStatus(s)).catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!status || !status.hosted) return null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await client.login(password);
      window.location.reload(); // every panel re-reads its data with the new session
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not sign in.");
      setBusy(false);
    }
  }

  if (!status.configured) {
    return (
      <div role="status" data-testid="access-banner" className="border-b border-border bg-amber-500/10 px-4 py-2 text-sm">
        The backend of this deployment is locked: the owner must set <code>GTPS_ACCESS_PASSWORD</code> (at least 8 characters) in the host&apos;s environment variables. Chats, the Lua workspace and backups still work.
      </div>
    );
  }

  if (status.authenticated) {
    return (
      <div role="status" data-testid="access-banner" className="flex items-center justify-between gap-3 border-b border-border bg-emerald-500/10 px-4 py-1.5 text-xs">
        <span>Backend unlocked.</span>
        <Button size="sm" variant="ghost" onClick={() => void client.logout().then(() => window.location.reload())}>Lock</Button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} data-testid="access-banner" className="flex flex-wrap items-center gap-2 border-b border-border bg-amber-500/10 px-4 py-2 text-sm">
      <span>The backend is locked. Enter the access password:</span>
      <Input
        type="password"
        aria-label="Access password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="h-8 w-48"
      />
      <Button type="submit" size="sm" disabled={busy || password === ""}>Unlock</Button>
      {error && <span role="alert" className="text-red-500">{error}</span>}
    </form>
  );
}
