/**
 * Runs once when the Next.js server process starts. This is what keeps
 * automatic synchronization alive independently of any browser tab.
 *
 * It must never stop the server from starting: on a hosting service (no writable disk, no background work)
 * it does nothing, and if the database cannot be opened the server still starts and every API route answers
 * with a clear "storage unavailable" error instead of the whole app failing.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { hostedPlatform } = await import("@/server/hosting");
  const platform = hostedPlatform();
  if (platform !== null) {
    console.warn(`[gtps-assistant] Running on ${platform}: the local backend is disabled; only the interface is served.`);
    return;
  }
  try {
    const { startBackgroundServices } = await import("@/server/sync/runtime");
    startBackgroundServices();
  } catch (error) {
    console.error(`[gtps-assistant] The background services could not start: ${error instanceof Error ? error.message : String(error)}`);
  }
}
