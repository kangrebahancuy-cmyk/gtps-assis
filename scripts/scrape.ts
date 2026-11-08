/**
 * Command-line scraper: `npm run scrape [-- --retry] [--render=static|auto|browser]`.
 * Writes to the same SQLite database as the web UI and prints real counts.
 */
import { openDatabase } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { HybridFetcher } from "@/server/scraper/browser-fetcher";
import { createConfig, getDatabasePath, type RenderMode } from "@/server/scraper/config";
import { Crawler } from "@/server/scraper/crawler";

const args = process.argv.slice(2);
const retry = args.includes("--retry");
const renderArg = args.find((a) => a.startsWith("--render="))?.split("=")[1];
const renderMode: RenderMode =
  renderArg === "static" || renderArg === "browser" ? renderArg : "auto";

const config = createConfig({ renderMode });
const repo = new Repository(openDatabase());
const fetcher = new HybridFetcher(config);

const controller = new AbortController();
process.on("SIGINT", () => {
  console.log("\nCancelling…");
  controller.abort();
});

const crawler = new Crawler({
  config,
  repo,
  fetcher,
  onProgress: (e) => {
    if (e.currentUrl) console.log(`[${e.processed + 1}/${e.total}] ${e.currentUrl}`);
  },
});

try {
  const summary = await crawler.run(retry ? "retry" : "full", controller.signal);
  const stats = repo.getStats();
  console.log("\nDatabase:", getDatabasePath());
  console.log(
    JSON.stringify({ run: summary, totals: stats }, null, 2),
  );
  for (const failed of repo.listFailed()) {
    console.log(`FAILED ${failed.url}: ${failed.error}`);
  }
  process.exitCode = summary.failed > 0 || summary.cancelled ? 1 : 0;
} finally {
  await fetcher.close();
}
