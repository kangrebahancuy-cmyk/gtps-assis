/**
 * Runs once when the Next.js server process starts. This is what keeps
 * automatic synchronization alive independently of any browser tab.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startBackgroundServices } = await import("@/server/sync/runtime");
  startBackgroundServices();
}
