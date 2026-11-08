/**
 * Command-line sync: `npm run scrape [-- --full | --incremental | --retry] [--render=static|auto|browser]`.
 * Uses the same SyncService as the web UI, writes to the same SQLite database
 * and prints real counts. Default mode is "auto" (full the first time, then incremental).
 */
import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { HybridFetcher } from "@/server/scraper/browser-fetcher";
import { createConfig, getDatabasePath, type RenderMode } from "@/server/scraper/config";
import { SyncService } from "@/server/sync/sync-service";
import type { SyncRequestMode } from "@/types/sync";

const args = process.argv.slice(2);
const mode: SyncRequestMode = args.includes("--retry")
  ? "retry"
  : args.includes("--full")
    ? "full"
    : args.includes("--incremental")
      ? "incremental"
      : "auto";
const renderArg = args.find((a) => a.startsWith("--render="))?.split("=")[1];
const renderMode: RenderMode = renderArg === "static" || renderArg === "browser" ? renderArg : "auto";

const repo = new Repository(openDatabase());
const service = new SyncService({
  repo,
  config: createConfig({ renderMode }),
  createFetcher: (config) => new HybridFetcher(config),
});

process.on("SIGINT", () => {
  console.log("\nCancelling…");
  service.cancel();
});

const result = service.start(mode, "manual");
if (!result.ok) {
  console.error(result.reason === "nothing-to-retry" ? "There are no failed documents to retry." : "A sync is already running.");
  process.exit(1);
}

await service.whenIdle();
const status = service.getStatus();
console.log(`\nMode: ${result.mode}   Database: ${getDatabasePath()}`);
console.log(JSON.stringify({ lastRun: status.lastRun, totals: status.totals }, null, 2));
for (const failed of status.failedPages) console.log(`FAILED ${failed.url}: ${failed.error}`);
process.exitCode = status.lastRun?.status === "completed" ? 0 : 1;
