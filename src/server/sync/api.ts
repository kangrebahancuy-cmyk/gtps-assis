import { AiError } from "@/server/ai/errors";
import { assertLocalRequest } from "@/server/ai/guard";
import {
  APPROVED_DOMAINS,
  DEFAULT_SOURCE_URL,
  DEFAULT_WEBSITE_URL,
  checkSourceUrl,
  type DocsSourceView,
} from "@/lib/docs-source";
import type { Repository } from "@/server/db/repository";
import { DocsSourceError, type DocsSourceStore } from "@/server/docs-source/store";
import { createConfig, type ScraperConfig } from "@/server/scraper/config";
import { SettingsError, type Scheduler } from "@/server/sync/scheduler";
import type { SyncService } from "@/server/sync/sync-service";
import type { SyncRequestMode, SyncStatus } from "@/types/sync";

/**
 * HTTP handlers for /api/sync/* and /api/docs-source/*. Plain Request/Response, so the route files are
 * one-liners and everything here is testable without Next.js. Errors are always `{ error: "message" }`
 * (what the browser's sync client expects), with `code` when the page needs to react to a specific case.
 */

export interface SyncApiDeps {
  service: SyncService;
  scheduler: Scheduler;
  repo: Repository;
  docsSource: DocsSourceStore;
  /** Combined engine + scheduler status. */
  status: () => SyncStatus;
}

const HEADERS = { "cache-control": "no-store" };
const json = (body: unknown, status = 200): Response => Response.json(body, { status, headers: HEADERS });
const fail = (message: string, status: number, code?: string): Response => json({ error: message, ...(code ? { code } : {}) }, status);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function readBody(request: Request, required: boolean): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > 16_384) throw new SettingsError("The request body is too large.");
  if (text.trim() === "") {
    if (required) throw new SettingsError("The request body must be a JSON object.");
    return {};
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new SettingsError("The request body is not valid JSON.");
  }
  if (!isObject(body)) throw new SettingsError("The request body must be a JSON object.");
  return body;
}

/** Same-origin/localhost checks first, then maps known errors to readable responses. */
function guardedSync(mutation: boolean, handler: (request: Request) => Promise<Response> | Response) {
  return async (request: Request): Promise<Response> => {
    try {
      assertLocalRequest(request, { mutation });
      return await handler(request);
    } catch (error) {
      if (error instanceof AiError) return fail(error.message, 403, "forbidden");
      if (error instanceof SettingsError) return fail(error.message, 400, "invalid");
      if (error instanceof DocsSourceError) return fail(error.message, error.code === "in_use" ? 409 : 400, error.code);
      return fail("Unexpected error in the local backend.", 500);
    }
  };
}

export const handleSyncStatus = (d: SyncApiDeps) => guardedSync(false, () => json(d.status()));

const MODES: readonly SyncRequestMode[] = ["auto", "full", "incremental", "retry"];
const START_MESSAGES = {
  "already-running": "A synchronization is already in progress.",
  "nothing-to-retry": "There are no failed documents to retry.",
} as const;

export const handleSyncStart = (d: SyncApiDeps) =>
  guardedSync(true, async (request) => {
    const body = await readBody(request, false);
    const mode = body.mode ?? "auto";
    if (typeof mode !== "string" || !MODES.includes(mode as SyncRequestMode)) return fail("mode must be auto, full, incremental or retry", 400, "invalid");
    // Defense in depth: never crawl a source that is not (or is no longer) allowed.
    const source = checkSourceUrl(d.service.getConfig().startUrl, d.docsSource.get().extraDomains);
    if (!source.ok) return fail(`The documentation source is not allowed: ${source.message}`, 409, "domain_not_approved");
    const result = d.service.start(mode as SyncRequestMode, "manual");
    if (!result.ok) return fail(START_MESSAGES[result.reason], 409, result.reason);
    return json({ started: true, runId: result.runId, mode: result.mode }, 202);
  });

const control = (d: SyncApiDeps, action: "pause" | "resume" | "cancel", message: string) =>
  guardedSync(true, async () => (d.service[action]() ? json({ ok: true }) : fail(message, 409, "not-applicable")));

export const handleSyncPause = (d: SyncApiDeps) => control(d, "pause", "There is no running synchronization to pause.");
export const handleSyncResume = (d: SyncApiDeps) => control(d, "resume", "There is no paused synchronization to resume.");
export const handleSyncCancel = (d: SyncApiDeps) => control(d, "cancel", "There is no running synchronization to cancel.");

export const handleGetSyncSettings = (d: SyncApiDeps) => guardedSync(false, () => json(d.scheduler.getSettings()));

export const handlePutSyncSettings = (d: SyncApiDeps) =>
  guardedSync(true, async (request) => {
    const { autoEnabled, intervalMinutes, schedulePaused } = await readBody(request, true);
    return json(
      d.scheduler.updateSettings({
        ...(autoEnabled !== undefined && { autoEnabled: autoEnabled as boolean }),
        ...(intervalMinutes !== undefined && { intervalMinutes: intervalMinutes as number }),
        ...(schedulePaused !== undefined && { schedulePaused: schedulePaused as boolean }),
      }),
    );
  });

export const handleSyncLogs = (d: SyncApiDeps) =>
  guardedSync(false, (request) => {
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? "200");
    return json({ logs: d.repo.getLogs(Number.isFinite(limit) ? limit : 200, params.get("runId") || null) });
  });

export const handleSyncRuns = (d: SyncApiDeps) => guardedSync(false, () => json({ runs: d.repo.listRuns(20) }));

// ---- documentation source -------------------------------------------------------------------

function view(d: SyncApiDeps): DocsSourceView {
  return {
    settings: d.docsSource.get(),
    approvedDomains: [...APPROVED_DOMAINS],
    defaults: { sourceUrl: DEFAULT_SOURCE_URL, websiteUrl: DEFAULT_WEBSITE_URL },
    documents: d.repo.getStats().documents,
    busy: d.service.isBusy(),
  };
}

/** The same crawl settings (delays, retries, limits), aimed at another start page. */
export function configForSource(config: ScraperConfig, sourceUrl: string): ScraperConfig {
  const { startUrl: _start, origin: _origin, pathPrefix: _prefix, ...rest } = config;
  return createConfig({ ...rest, startUrl: sourceUrl });
}

export const handleGetDocsSource = (d: SyncApiDeps) => guardedSync(false, () => json(view(d)));

/**
 * PUT { sourceUrl?, websiteUrl?, confirmChange? }. Changing the crawl source while documents are indexed
 * needs `confirmChange: true`: the indexed pages are kept, but they belong to the old source.
 */
export const handlePutDocsSource = (d: SyncApiDeps) =>
  guardedSync(true, async (request) => {
    const body = await readBody(request, true);
    const before = d.docsSource.get();
    const requested = body.sourceUrl === undefined ? null : checkSourceUrl(body.sourceUrl, before.extraDomains);
    const sourceChanges = requested !== null && requested.ok && requested.url !== before.sourceUrl;
    if (sourceChanges && d.service.isBusy()) return fail("A synchronization is running. Stop it before changing the documentation source.", 409, "busy");
    const documents = d.repo.getStats().documents;
    if (sourceChanges && documents > 0 && body.confirmChange !== true) {
      return json(
        {
          error: `${documents} document(s) from the current source are indexed. Changing the source keeps them, but the next synchronization will index the new source next to them. Confirm to continue.`,
          code: "confirmation_required",
          documents,
        },
        409,
      );
    }
    const settings = d.docsSource.update({ sourceUrl: body.sourceUrl, websiteUrl: body.websiteUrl });
    if (sourceChanges) d.service.setConfig(configForSource(d.service.getConfig(), settings.sourceUrl));
    return json(view(d));
  });

/** POST { domain, confirm: true }: the local user explicitly trusts another host. */
export const handleAddDomain = (d: SyncApiDeps) =>
  guardedSync(true, async (request) => {
    const body = await readBody(request, true);
    if (body.confirm !== true) return fail("Adding a domain needs explicit confirmation (confirm: true).", 400, "confirmation_required");
    d.docsSource.addDomain(body.domain);
    return json(view(d));
  });

/** DELETE ?domain=host. No body (DELETE has none), so the JSON content-type rule does not apply; the host/origin checks still do. */
export const handleRemoveDomain = (d: SyncApiDeps) =>
  guardedSync(false, async (request) => {
    d.docsSource.removeDomain(new URL(request.url).searchParams.get("domain"));
    return json(view(d));
  });
