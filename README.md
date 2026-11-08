# GTPS Assistant

An AI-powered development assistant for GTPS Cloud developers.

> **Status: Step 3 (documentation synchronization engine) added on top of Steps 1 and 2.**
> There is **no AI provider and no Lua generator yet**. Controls that depend
> on them are disabled and labelled as unavailable.

## Tech stack

- Next.js 15 (App Router) and React 19
- TypeScript (strict)
- Tailwind CSS 3 with shadcn/ui-style components (Radix primitives)
- Lucide icons
- Zustand for state (persisted to `localStorage`)
- Monaco Editor (`@monaco-editor/react`) for the Lua workspace

## Requirements

- Node.js 22.13 or newer (the scraper uses the built-in `node:sqlite`)
- npm 10 or newer

## Installation

```bash
git clone https://github.com/kangrebahancuy-cmyk/gtps-assis.git
cd gtps-assis
npm install
```

## Development

```bash
npm run dev        # start the dev server at http://localhost:3000
npm run typecheck  # TypeScript check (tsc --noEmit)
npm run lint       # ESLint
npm run build      # production build
npm run start      # serve the production build
```

## What works in this step

| Area | Working | Not yet available |
| --- | --- | --- |
| Shell | Collapsible sidebar, mobile drawer, active indicator, dark/light theme | - |
| Chats | New chat, local history list, search by title, delete | Sending messages (no provider) |
| Composer | Typing, example prompts fill the draft | Send button is disabled |
| Documentation | Search, category filter, viewer with code blocks (sample pages) | Real GTPS Cloud documentation |
| Lua Workspace | Monaco editor, file tabs, live preview, local persistence | Download, Lua generation |
| Settings | Theme switch, local data size and clearing | Providers, models, sync, chat preferences |

The documentation pages are static **layout samples** and are labelled as such
in the UI.

## Documentation scraper (Step 2)

Source: <https://dash.gtps.cloud/docs> (same origin only, never outside `/docs`).

```bash
npm install
npx playwright install chromium   # only needed for client-rendered pages
npm run scrape                     # CLI sync (auto: full first, then incremental)
npm run scrape -- --full           # re-fetch everything
npm run scrape -- --incremental    # only reprocess what changed
npm run scrape -- --retry          # retry only failed pages
npm run scrape -- --render=static  # plain HTTP only (never starts a browser)
npm test                           # unit tests
```

Or use **Documentation → Start Scraping / Cancel / Retry failed / View logs** in
the app. Data is stored in `data/gtps-assistant.db` (override with
`GTPS_DB_PATH`). Tables: `documents`, `categories`, `document_sections`,
`code_examples`, `api_entries`, `document_links`, `crawl_urls`,
`scraping_logs`, `sync_metadata`.

How it behaves:

- Reads `robots.txt` first. If it cannot be read, nothing is crawled. Disallowed
  URLs are recorded as `blocked`, never requested. `Crawl-delay` is honoured.
- One request per second by default, timeouts, and retries (network, timeout,
  429, 5xx only). No authentication or access restrictions are bypassed.
- Fetches over plain HTTP and uses Playwright only if a page looks
  client-rendered (`auto`). Cheerio parses the HTML.
- Every failure (network, timeout, HTTP error, empty or invalid content,
  browser error, redirect out of `/docs`) is stored with its reason and shown in
  the UI. Nothing is silently skipped.
- Duplicate URLs are normalized (hash, trailing slash, tracking params) and
  crawled once. Different URLs with identical content are marked `duplicate`.

Known limitations:

- The extractor relies on semantic tags (headings, `p`, `li`, `table`, `pre`).
  API descriptions and return types are inferred from text near each code
  block, so they can be `null` if the live markup differs from what was
  inspected. Run `npm run scrape` and review the results before relying on them.
- The built-in documentation viewer shows cleaned text; code examples are
  stored in the database but not yet rendered in the viewer.

## Documentation synchronization (Step 3)

Everything is on **Documentation** page (top panel) and also available through
`npm run scrape` and `/api/sync/*`.

| Action | What it does |
| --- | --- |
| Sync now | Full sync the first time, incremental afterwards |
| Incremental | Re-checks known pages with `If-None-Match` / `If-Modified-Since`; a `304` page is not re-parsed. Pages without validators are re-fetched but only rewritten when their content hash changed |
| Full sync | Re-fetches every known page (including ones marked deleted) |
| Retry failed | Re-checks only the URLs whose last attempt failed |
| Pause / Resume / Cancel | Take effect between pages. A cancelled run keeps everything it already saved |

**Change detection** uses the URL, the content hash, `ETag` / `Last-Modified`
when the server sends them, and the time of the last check:

- *New*: a URL seen for the first time (start page is always fetched in full
  because its navigation reveals new pages).
- *Updated*: same URL, different content hash. A page that comes back after
  being marked deleted is restored and counted as updated.
- *Unchanged*: `304`, or same hash. Nothing is rewritten.
- *Deleted*: only when the source answers **404 or 410** for a page that was
  indexed. The text is **kept** and flagged (soft delete), so nothing is lost.
- *Failed*: network errors, timeouts, 429, 5xx, empty or invalid content. These
  are treated as temporary: the indexed copy is never removed because of them.
  If `robots.txt` cannot be read the whole run fails and the index is untouched.

A run is "successful" (it moves *Last successful synchronization*) only when it
finished, was not cancelled, and had no failures. Every run is stored in
`sync_runs`; the activity log can be filtered per run. Runs left open by a
stopped backend are marked `interrupted` on the next start.

### Automatic sync and the scheduler

Automatic sync runs in a **backend scheduler** that starts with the Next.js
server (`src/instrumentation.ts`), not in the browser. Closing or reloading the
tab does not stop it.

**It only runs while the local backend process is running.** If you stop
`npm run dev` / `npm start`, nothing is synchronized. The dashboard shows a
heartbeat-based status ("Running in the local backend" / "Not running" /
"Backend unreachable"), and if a run came due while the backend was down, it
starts when the backend is started again and a notice says so. Missed runs are
not replayed more than once. For unattended use, keep the production server
(`npm run build && npm start`) running, for example under a process manager.

Settings (stored in SQLite): on/off, interval (5 minutes to 7 days), pause
schedule. Automatic sync is **off by default**.

Limits worth knowing: only one run at a time; a manual run postpones the next
scheduled one; pages rendered with Playwright do not store validators, so they
are always re-rendered in incremental mode; whether a `304` is possible depends
on whether the site sends `ETag` / `Last-Modified` (otherwise hashing is used).

## Project structure

```
src/
  app/            Routes (App Router): /, /chat, /docs, /workspace, /settings/[section]
  components/
    layout/       App shell, sidebar, logo, theme toggle
    ui/           Reusable primitives (button, input, card, badge, switch, sheet)
  features/       Feature modules: dashboard, chat, docs, workspace, settings
  hooks/          Reusable React hooks
  lib/            Constants, navigation helpers, markdown parser, utilities
  server/         Scraper, sync service + scheduler, SQLite layer (server only)
  services/       Browser storage and scraper API client
  store/          Zustand stores (ui, chat, workspace)
  types/          Shared TypeScript types
```

## Notes

- The Monaco editor loads its assets from a CDN at runtime, so the Lua
  workspace editor needs internet access in the browser.
- All data is stored in the browser's `localStorage`. Use **Settings → Local
  Data** to clear it.
- Fonts use the system font stack, so builds do not depend on external font
  downloads.

## Roadmap

1. **Step 1:** project foundation and UI.
2. **Step 2:** documentation scraper and local SQLite storage.
3. **Step 3:** synchronization engine (incremental sync, scheduler).
4. Later steps: AI provider integration, Lua generation.
