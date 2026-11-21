/**
 * The real sync backend (SyncService, Scheduler, DocsSourceStore, the /api/sync and /api/docs-source handlers)
 * in front of a local fake documentation SITE served over HTTP. Page bodies are the JSON format understood by
 * `fakeExtract` (see tests/helpers.ts), so this exercises real fetching, retries, ETags and robots.txt but not
 * the HTML extractor. The pages are synthetic test data, not real GTPS Cloud documentation.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { openDatabase, type Db } from "@/server/db/database";
import { Repository } from "@/server/db/repository";
import { DocsSourceStore } from "@/server/docs-source/store";
import { createConfig } from "@/server/scraper/config";
import { fetchStatic, withRetries, type PageFetcher } from "@/server/scraper/fetcher";
import {
  handleAddDomain, handleGetDocsSource, handleGetSyncSettings, handlePutDocsSource, handlePutSyncSettings, handleRemoveDomain,
  handleSyncCancel, handleSyncLogs, handleSyncPause, handleSyncResume, handleSyncRuns, handleSyncStart, handleSyncStatus,
  type SyncApiDeps,
} from "@/server/sync/api";
import { Scheduler } from "@/server/sync/scheduler";
import { SyncService } from "@/server/sync/sync-service";
import type { SyncStatus } from "@/types/sync";
import { body, fakeExtract } from "../helpers";

export interface SitePage {
  text: string;
  links?: string[];
  /** Non-200 status to answer with instead of the page. */
  status?: number;
  /** Milliseconds to wait before answering (keeps a run open for pause/cancel tests). */
  delayMs?: number;
}

export interface Site {
  origin: string;
  host: string;
  pages: Record<string, SitePage>;
  hits: string[];
  close(): Promise<void>;
}

export const defaultPages = (): Record<string, SitePage> => ({
  "/docs": { text: "Welcome to the fixture documentation overview.", links: ["/docs/alpha", "/docs/beta"] },
  "/docs/alpha": { text: "Alpha page: a synthetic description of the alpha topic." },
  "/docs/beta": { text: "Beta page: a synthetic description of the beta topic." },
});

export async function startSite(pages: Record<string, SitePage> = defaultPages()): Promise<Site> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    hits.push(path);
    if (path === "/robots.txt") { res.writeHead(404); return void res.end(); }
    const page = site.pages[path];
    const answer = () => {
      if (!page) { res.writeHead(404, { "content-type": "text/html" }); return void res.end("not found"); }
      if (page.status) { res.writeHead(page.status, { "content-type": "text/html" }); return void res.end("error"); }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body({ title: path, text: page.text, links: page.links }));
    };
    if (page?.delayMs) setTimeout(answer, page.delayMs); else answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const site: Site = {
    origin: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    pages,
    hits,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
  return site;
}

export interface SyncRig {
  db: Db;
  repo: Repository;
  service: SyncService;
  scheduler: Scheduler;
  docsSource: DocsSourceStore;
  deps: SyncApiDeps;
  /** Routes /api/sync/* and /api/docs-source/* to the real handlers; null for other paths. */
  route(request: Request): Promise<Response> | Response | null;
  /** Calls the handler in-process. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  /** Starts a sync directly and waits until it ends. */
  runSync(mode?: "auto" | "full" | "incremental" | "retry"): Promise<SyncStatus>;
  close(): void;
}

export function createSyncRig(): SyncRig {
  const db = openDatabase(":memory:");
  const repo = new Repository(db);
  const docsSource = new DocsSourceStore(repo);
  const service = new SyncService({
    repo,
    config: createConfig({ startUrl: docsSource.get().sourceUrl, requestDelayMs: 0, maxRetries: 1, retryBackoffMs: 1, timeoutMs: 2000, minContentLength: 5 }),
    createFetcher: (config): PageFetcher => ({
      fetchPage: (url, signal, validators) =>
        withRetries(() => fetchStatic(url, config, signal, fetch, validators ?? null), { maxRetries: config.maxRetries, backoffMs: 1, signal, sleep: async () => {} }),
      close: async () => {},
    }),
    extract: (html, url, cfg) => fakeExtract(html, url, cfg),
    sleep: async () => {},
  });
  const scheduler = new Scheduler({ repo, service });
  const status = (): SyncStatus => ({ ...service.getStatus(), scheduler: scheduler.getStatus() });
  const deps: SyncApiDeps = { service, scheduler, repo, docsSource, status };

  const route = (request: Request): Promise<Response> | Response | null => {
    const { pathname } = new URL(request.url);
    const m = request.method;
    switch (pathname) {
      case "/api/sync/status": return handleSyncStatus(deps)(request);
      case "/api/sync/start": return handleSyncStart(deps)(request);
      case "/api/sync/pause": return handleSyncPause(deps)(request);
      case "/api/sync/resume": return handleSyncResume(deps)(request);
      case "/api/sync/cancel": return handleSyncCancel(deps)(request);
      case "/api/sync/settings": return m === "PUT" ? handlePutSyncSettings(deps)(request) : handleGetSyncSettings(deps)(request);
      case "/api/sync/logs": return handleSyncLogs(deps)(request);
      case "/api/sync/runs": return handleSyncRuns(deps)(request);
      case "/api/docs-source": return m === "PUT" ? handlePutDocsSource(deps)(request) : handleGetDocsSource(deps)(request);
      case "/api/docs-source/domains": return m === "DELETE" ? handleRemoveDomain(deps)(request) : handleAddDomain(deps)(request);
      default: return null;
    }
  };

  return {
    db, repo, service, scheduler, docsSource, deps, route,
    async call(method, path, payload, headers = {}) {
      const request = new Request(`http://localhost:3000${path}`, {
        method,
        headers: { host: "localhost:3000", ...(payload === undefined ? {} : { "content-type": "application/json" }), ...headers },
        body: payload === undefined ? null : JSON.stringify(payload),
      });
      const response = (await route(request)) as Response;
      return { status: response.status, body: await response.json() };
    },
    async runSync(mode = "auto") {
      const started = service.start(mode);
      if (!started.ok) throw new Error(`could not start: ${started.reason}`);
      await service.whenIdle();
      return status();
    },
    close() {
      scheduler.stop();
    },
  };
}
