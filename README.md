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
| Chats | AI chat with streaming, Markdown and Lua highlighting; history in IndexedDB (search, rename, delete, export/import) | Documentation-aware answers (no RAG yet) |
| Composer | Multiline input, Enter/Shift+Enter, Stop, example prompts | - |
| Documentation | Explorer over the indexed GTPS Cloud docs: hierarchy, FTS5 search, Markdown viewer, status | Content appears only after a sync has been run |
| Lua Workspace | Monaco editor, file tabs, live preview, local persistence | Download, Lua generation |
| Settings | Theme switch, local data size and clearing, AI providers (Gemini, Groq), model discovery and default model, chat history export/import/clear | Sync preferences |

The documentation explorer shows nothing until a synchronization has been run:
there are no sample pages any more.

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

## Documentation explorer (Step 4)

The **Documentation** page reads only the SQLite database filled by the sync
engine; no page, category or API name is hardcoded.

- **Navigation.** *Pages* shows the indexed hierarchy: categories and
  subcategories read from the site's sidebar groups, then pages. Pages the
  extractor found no sidebar group for are arranged by URL path instead (such
  nodes are marked `url-path` in the API). *API* lists every function, method,
  callback and event grouped by owner; *Lua examples* lists every Lua code block
  with its page. Kinds are derived from the signature (`...Callback` = callback,
  `on...` globals = event, `Name:member` = method), not read from the site.
- **Search (SQLite FTS5).** Scopes: everything, title, keyword (page text), API
  name, function (functions and methods only) and inside code examples. Page
  text uses a stemmed index (`teleporting` finds `Teleport`, last word matches as
  a prefix). API names and code use a trigram index, so `chat` finds
  `onPlayerChatCallback`; terms shorter than 3 characters fall back to `LIKE`.
  Results show title, highlighted matching text, category and original URL.
- **Viewer.** Pages are stored as Markdown (headings, lists, GFM tables, fenced
  code with language) and rendered by a dependency-free parser as React
  elements, never raw HTML; links are limited to http(s). Lua blocks are
  syntax-highlighted and have a copy button. Each page shows its original URL,
  the date it was last synchronized and when its content last changed. Links to
  other indexed pages open inside the explorer.
- **Status bar.** Indexed documents, API entries, Lua examples, last successful
  sync, failed pages (with the error) and live sync state, all read from the
  database / sync engine. A warning appears if the search index is out of step.

HTTP API (all read-only): `GET /api/docs/tree`, `/document?id=|url=`,
`/search?q=&scope=&limit=`, `/api?kind=`, `/examples?language=`, `/status`.

Upgrading: opening an existing database migrates it in place (schema v3) and
builds the search index once. Pages stored by Step 2/3 contain plain text; they
are converted to Markdown the next time they change on the site, or run a
**Full sync** to refresh everything at once (changed hashes show up as
"updated" once).

### Tests

```bash
npm test        # server tests (node:test): extraction, FTS, explorer, sync, end-to-end over local HTTP
npm run test:ui # server-side render tests for the explorer and AI settings components (tests/ui)
```

## AI providers (Step 5)

Google Gemini and Groq are interchangeable behind one backend service. The
chat UI (Step 6, below) uses the browser client `src/services/ai-client.ts`.

### Setup

1. Get a key: [Gemini](https://aistudio.google.com/apikey), [Groq](https://console.groq.com/keys).
2. Either open **Settings → AI Providers** and paste it, or copy `.env.example`
   to `.env.local` and fill `GEMINI_API_KEY` / `GROQ_API_KEY`. A key saved in
   Settings wins over the environment one.
3. Use **Test connection**, then pick a default in **Settings → Models**.

### How it works

- `src/server/ai/` holds the provider abstraction (`AiProvider`), the two
  adapters, the service (`AiService`) and the HTTP handlers. Routes under
  `src/app/api/ai/` (`settings`, `config`, `models`, `test`, `chat`) only
  delegate to them.
- **Models are discovered live** from each provider; no model names are
  hardcoded. The list shows provider, model ID, name, context window (when the
  provider reports it), coding capability, free-tier status and availability.
  Lists are cached for 10 minutes; **Refresh models** bypasses the cache and an
  older list is kept (marked stale) if a refresh fails.
- **Free tier is never assumed.** Neither API says whether a model is free, so
  every model shows "Not verified" and links to the provider's rate-limit page.
  Free-tier eligibility is also kept separate from **observed quota**: Groq's
  `x-ratelimit-*` headers are shown as "reported in the last response";
  Gemini reports no remaining quota, so none is shown.
- **Coding capability** is "Code-focused (by name)" only when the model name
  says so, otherwise "Not known". Groq marks non-chat/inactive models by name
  heuristics, shown as "guessed from the name".
- **Streaming**: `POST /api/ai/chat` returns server-sent events
  (`start`, `delta`, `usage`, `done`, `error`) with the same shape for both
  providers. Errors before the provider accepted the request are normal JSON
  errors with a matching status; later ones arrive as an `error` event.
- **Errors and rate limits**: provider errors are mapped to a fixed set of kinds
  (invalid key, rate limited, model not found, ...) with sanitized messages.
  429/5xx/network failures are retried with backoff; a short `Retry-After` is
  waited out, a long one is reported (with `Retry-After`) and chat to that
  provider is paused locally for that period (capped at 15 min) instead of
  hammering the API. Testing a connection and refreshing models are not blocked
  by the pause.
- **Switching provider** = changing the default (or passing `provider`/`model`
  in one request). The calling code and the events are identical.

### Security

- Keys are used only by the local backend. They are never returned by any API
  (only `configured`, source and the last 4 characters), never put in a URL, and
  redacted from error messages. The browser sends a key only when you save or
  test it.
- Saved keys live in `data/ai-config.json` as **plain text** (file mode 0600,
  gitignored). That guards against accidental commits and other local users, not
  against anyone who can read your files. `.env*` is ignored except
  `.env.example`, which has no values.
- `/api/ai/*` answers only requests addressed to `localhost`, `127.0.0.1` or
  `[::1]` (blocks DNS rebinding), rejects cross-site/cross-origin requests and
  requires `application/json` for writes. Set `GTPS_ALLOWED_HOSTS` to allow
  another host name. There is no user login: anyone who can reach the app as
  localhost can use your keys, so do not expose the dev server to a network.
- All input is validated (provider, key format, model ID, message count/size,
  temperature, token limit).

### What is and is not verified

- Tests (`tests/ai-*.test.ts`, `tests/sse.test.ts`, `tests/ui/ai-settings.test.tsx`)
  run the real adapters, service, handlers and client over real HTTP against
  **local imitations** of the Gemini and Groq APIs written from their public
  documentation. **The real services were never contacted**, so field names,
  error formats and rate-limit headers are as documented, not proven. In
  particular the Groq `/models` response fields are not specified in the docs
  and are treated as optional.
- The settings UI was only server-rendered in tests, never opened in a browser.
  `next build`, ESLint and the Cheerio extractor test have not been run in this
  environment because the packages are not installed here.

## AI chat (Step 6)

A ChatGPT-style chat on top of the Step 5 providers. Everything is stored in the
browser; there is no login and no cloud database.

### Features

- New chat, welcome screen with example prompts, multiline composer that grows
  up to 220 px, character limit of 100,000.
- Streaming replies, Markdown (no raw HTML; only `http(s)` links), Lua syntax
  highlighting in code blocks, copy for messages and code.
- **Stop** a reply (keeps the text received so far), **Regenerate** the last
  reply (with the model currently selected), **Edit** a question (the later
  messages are removed and the edited question is answered again; there is no
  branching).
- Auto-scroll that follows new text, stops when you scroll up, and offers a
  "Scroll to latest message" button.
- Loading states and errors on the reply itself (invalid key, rate limit,
  network, interrupted reply) with a retry; a chat can keep working after an
  error.
- Provider and model selectors in the header. The choice is remembered **per
  conversation**, and the last choice is used for new chats.
- Several chats may generate at the same time (one reply per chat).

### Keyboard shortcuts

| Where | Keys | Action |
| --- | --- | --- |
| Composer | Enter | Send |
| Composer | Shift+Enter | New line |
| Composer | Esc | Stop generating |
| Editing a question | Ctrl+Enter | Save and resend |
| Editing a question | Esc | Cancel |
| Renaming a chat | Enter / Esc | Save / cancel |

### History storage (IndexedDB)

Database `gtps-assistant-chat`, version 1:

| Store | Key | Index | Content |
| --- | --- | --- | --- |
| `conversations` | `id` | `updatedAt` | title, titleSource (auto/manual), createdAt, updatedAt, provider, model, messageCount, metadata |
| `messages` | `id` | `conversationId` | order, role, content, createdAt, updatedAt, status, provider, model, meta (finish reason, usage, error, edited) |
| `meta` | `key` | - | open chat, last provider/model |

Writes use one transaction per change and abort as a whole when something
fails. While a reply streams it is saved at most every 400 ms, so closing the
tab loses at most that much; on the next load a reply still marked as
streaming is shown as "interrupted". If IndexedDB is unavailable (some private
modes) the app falls back to in-memory history and says so on screen; it then
does **not** survive a refresh.

Search is a client-side substring match over titles and message text (all
words must match). Rename marks the title as manual, so it is no longer
replaced by the first question.

### Export / import

**Settings → Chat history → Export JSON** downloads
`{"format": "gtps-assistant-chat-export", "version": 1, "exportedAt", "conversations": [{...conversation, "messages": [...]}]}`.
Import validates the file strictly (type, size up to 50 MB, roles, statuses,
timestamps) and changes nothing when it is invalid. Chats whose id already
exists are skipped (not overwritten), clashing message ids are remapped, and
"streaming" replies become "interrupted". API keys are never part of an export
(they are never in the browser).

### Tests

```bash
node --import tsx --no-warnings --test tests/*.test.ts          # server, engine, storage contract (memory)
node --import tsx --no-warnings --test tests/ui/*.test.tsx       # server-rendered UI
npm run test:browser                                             # real Chromium + real IndexedDB
```

`tests/chat-engine.test.ts` drives the real controller against the real AI
client, handlers and service over HTTP to local fake Gemini/Groq servers.
`tests/browser/*.browser.ts` bundles the real chat UI with esbuild and runs it
in Chromium through Playwright (it needs Playwright and esbuild installed; they
are not in `package.json`).

### What is and is not verified

- Verified in real Chromium with real IndexedDB: new and multiple
  conversations, reload and browser-restart persistence, a page closed in the
  middle of a reply, model switching and per-chat memory, streaming, stop,
  regenerate, edit, search, rename, delete, export/import/clear, error
  recovery, auto-scroll.
- **The real Gemini and Groq services were never contacted**; only local
  imitations were used.
- **Tailwind CSS cannot be built here**, so the real styling, layout on phones,
  dark mode and visual polish were **not** seen. The browser tests use a few
  stand-in CSS rules for layout. `next build` and ESLint were not run, and the
  React components were not type-checked against `@types/react` (not installed
  here).
- Several browser tabs open at once are not coordinated: the last write wins.
- The assistant knows nothing about GTPS documentation yet (no RAG); its system
  prompt tells it not to guess API names.

## Project structure

```
src/
  app/            Routes (App Router): /, /chat, /docs, /workspace, /settings/[section]
  components/
    layout/       App shell, sidebar, logo, theme toggle
    ui/           Reusable primitives (button, input, card, badge, switch, sheet)
  features/       Feature modules: dashboard, chat, docs, workspace, settings
  hooks/          Reusable React hooks
  lib/            Constants, navigation helpers, markdown parser, Lua highlighter, utilities
    chat/         Chat engine: controller, IndexedDB/memory repositories, context, search, export
  server/         Scraper, sync service + scheduler, SQLite layer, docs explorer, AI providers/service (server only)
  services/       Browser storage and scraper API client
  store/          Zustand stores (ui, workspace)
  types/          Shared TypeScript types
```

## Notes

- The Monaco editor loads its assets from a CDN at runtime, so the Lua
  workspace editor needs internet access in the browser.
- Settings, workspace files and theme are stored in `localStorage`; chat history
  is in IndexedDB. Use **Settings → Local Data** to clear everything.
- Fonts use the system font stack, so builds do not depend on external font
  downloads.

## Roadmap

1. **Step 1:** project foundation and UI.
2. **Step 2:** documentation scraper and local SQLite storage.
3. **Step 3:** synchronization engine (incremental sync, scheduler).
4. **Step 4:** documentation explorer (hierarchy, FTS5 search, viewer, status).
5. **Step 5:** multi-provider AI integration (Gemini, Groq), settings, unified service.
6. **Step 6:** AI chat (streaming, history in IndexedDB, model selector).
7. Later steps: documentation-aware answers (RAG), Lua generation.
