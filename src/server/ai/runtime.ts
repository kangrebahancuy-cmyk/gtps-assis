import { AiConfigStore } from "@/server/ai/config-store";
import { AiService } from "@/server/ai/service";
import { getAiConfigPath } from "@/server/scraper/config";

const globalForAi = globalThis as unknown as { __gtpsAiService?: AiService };

/** One AiService per server process (kept across dev hot reloads). */
export function getAiService(): AiService {
  globalForAi.__gtpsAiService ??= new AiService({ store: new AiConfigStore(getAiConfigPath()) });
  return globalForAi.__gtpsAiService;
}
