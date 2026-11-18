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
| Chats | AI chat with streaming, Markdown and Lua highlighting; history in IndexedDB (search, rename, delete, export/import) | Real-model answer quality (never tested against real Gemini/Groq) |
| Composer | Multiline input, Enter/Shift+Enter, Stop, example prompts | - |
| Documentation | Explorer over the indexed GTPS Cloud docs: hierarchy, FTS5 search, Markdown viewer, status | Content appears only after a sync has been run |
| Lua Workspace | Monaco editor (basic-editor fallback), file tabs, create/rename/delete/import/export, IndexedDB storage, syntax check, documentation check, AI assistant (explain, fix, optimize, comment, refactor, modify, generate) | Real Monaco and real GTPS runtime were never tested here; scripts are never executed |
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
- Documentation search was added in Step 7 (next section).

## Documentation-aware answers (Step 7)

The chat searches the indexed GTPS Cloud documentation **on the server** before each
question and sends only the relevant sections to Gemini or Groq. The browser never
receives the whole database, and cannot replace the system prompt.

```
question -> intent detection -> FTS5 search -> ranking and filtering -> token budget
         -> prompt (rules + numbered excerpts) -> Gemini/Groq -> answer + sources
```

### Index (SQLite, schema version 4)

| Table | Content |
| --- | --- |
| `doc_chunks` | one row per chunk: document, kind (`section`, `api`, `code`), heading, heading id (`anchor`), API name (`label`), text, token estimate |
| `search_chunks` | FTS5 (`porter unicode61`) over heading, text and `idents` (camelCase names split into words), rowid = chunk id |

Chunks are written by the same code path that saves a page (`indexDocument`), so every
synchronization updates them. A database from before Step 7 is chunked once when it is opened.

- Sections are cut at paragraph boundaries (about 2,200 characters, one paragraph of overlap),
  never inside a code block; tiny sections are merged into the next one.
- Every API entry is one chunk (signature, parameters, returns, description); every code
  example is one chunk with its context line.

### Retrieval and ranking (`src/server/rag/`)

- **Intent** (`intent.ts`): rule-based, English and Indonesian. Finds API names (`Player:getName`,
  `onPlayerChatCallback`, anything in backticks, calls in pasted code), drops stop words and words
  like "parameters" that name a field rather than a topic, applies a small Indonesian-to-English
  glossary, and skips greetings.
- **Candidates**: FTS5 `bm25` over the words and identifier phrases, plus an exact lookup of API
  names (case-insensitive, with or without the owner).
- **Ranking**: weighted term coverage (rare words count more), bm25 rank, exact API-name match,
  title match and fit between the question type and the chunk type. Weak matches are filtered out
  by an absolute and a relative threshold.
- **Selection**: at most 8 excerpts and 3 per page, near-duplicates and examples already inside a
  selected section are dropped, and the text is cut to a budget (default 4,500 estimated tokens).
- **Conflicts**: when two pages document the same API with different signatures, both are sent and
  flagged so the model must report the disagreement.
- **Name check**: every API name in the question or in a pasted script is looked up in the API
  entries and the result ("documented" / "NOT FOUND") is given to the model.

**Semantic (embedding) search is not implemented.** There is no embedding model available
offline and none was added; matching is lexical (stemming, identifier splitting, glossary).

### Prompt and prompt-injection defence

The system prompt (`prompt.ts`) is written by the server: GTPS Cloud Lua specialist; prioritize the
indexed documentation; never invent API methods; verify names and parameters; separate documented
facts from assumptions; say when information is missing; cite URLs as `[n]`; preserve the behavior
of scripts being modified; report conflicting pages. Excerpts go in the **user** turn between
`<<<SOURCE-<random id>` and `<<<END-<random id>` markers (a new id per request) and are declared to
be data. Scraped text is also neutralized: invisible characters are removed, look-alike markers are
defused, and lines that read as instructions to an AI (English and Indonesian patterns) are removed
and counted. This lowers the risk; it cannot guarantee how a real model behaves.

When nothing relevant is found, or the index is empty or fails, the model is told so and must not
state GTPS API details as fact; the chat keeps working.

### What the chat shows

- Under each answer: the numbered sources (page, section, kind, original URL, **Open** in the
  documentation viewer at the section, excerpt) and which ones the answer actually cites.
- In the chat header: **Documentation Search** (Active / Off / Unavailable / Unknown),
  **Documents Retrieved** and **Sources Used** from the latest reply (`—` when nothing was searched,
  never an invented number), and **Last Documentation Sync** from the database. The checkbox turns
  documentation search off; the choice is remembered.

`POST /api/ai/chat` accepts `docs: true` and answers with an extra `context` event right after
`start`; `GET /api/docs/context` returns `{available, documents, chunks, lastSyncAt}`.

### Tests

```bash
node --import tsx --no-warnings --test tests/rag-retrieval.test.ts tests/rag-chat.test.ts
```

- `rag-retrieval.test.ts` (33): chunking, index upkeep and migration, intent, retrieval of pages,
  API names, parameters and code examples, citations, nothing found, conflicts, prompt injection,
  token budget.
- `rag-chat.test.ts` (17): the real chat client and handler with a SQLite documentation database in
  front of fake Gemini/Groq servers; asserts what the providers **received**.
- `tests/ui/sources-panel.test.tsx` (4) and the Chromium suite (`chat.browser.ts`, indicator,
  sources, links, reload, toggle).

### Verified and not verified

- Verified: the excerpts, rules, URLs and removal of injected lines are in the requests that Gemini
  and Groq adapters send (checked against local fake servers), and the UI shows sources and counts
  that come from the backend's record of the search.
- **The tests use a synthetic documentation set** (`tests/support/gtps-docs-fixture.ts`, 8 pages).
  No synchronized GTPS Cloud database exists in this environment, so retrieval was **not** run on
  the real documentation, and the ranking thresholds were tuned on this tiny set only. Run a sync,
  then try real questions before trusting them.
- Real Gemini/Groq were not contacted: whether a real model cites correctly or resists injected
  text is untested. Groq free-tier token limits may need a smaller budget (`maxContextTokens`).

## Lua Script Generator (Step 8)

Open **Script Generator** in the sidebar (`/generator`). Describe a script in your own words (English or
Indonesian), or paste a script and say what to change. Each generator conversation is separate from the
normal chats (marked "script" in the history); the Gemini/Groq switch works as everywhere else.

### What happens on every request (`src/server/lua/`)

1. **Analyse the request** (`features.ts`, rule-based): which kind of script (custom command, daily reward,
   NPC shop, automatic event, moderation, mailbox, item interaction), and whether it modifies a script
   (pasted code, or a follow-up to the previous reply).
2. **Search the documentation, one search per topic** (`generate.ts`): the request itself plus the topics
   the script type needs (for example for a daily reward: giving items, server time, saving data,
   messages), plus callback/event registration. Excerpts from all topics are merged round-robin so each topic
   gets its share. Retrieval **cannot be skipped**: generate mode forces it, and without a documentation
   index the request is refused (HTTP 409) instead of running unguided.
3. **Verified API reference**: the API entries on the retrieved pages (signature, parameters, returns), plus the
   complete list of documented event and callback names, go into the prompt next to the excerpts.
4. **Generator prompt**: the model must use only those names, never present standard Lua as GTPS API, say what the
   documentation is missing (`-- NOT IMPLEMENTED: needs ...`), return the complete script in one `lua` block, and
   answer in the fixed format: Script name, Purpose, (What changed), Complete Lua code, Required configuration,
   Installation instructions, Usage instructions, Explanation, Documentation references, Known limitations.
5. **Check the finished script** (`src/lib/lua/`, `verify.ts`) and stream the result as a `script_check` event.

### The script check (no Lua binary needed)

- **Syntax**: a real Lua 5.1-5.4 lexer and recursive-descent parser with line/column errors worded like the
  reference compiler (`'end' expected (to close 'if' at line 2) near <eof>`).
- **API names**: every call is looked up in the indexed documentation (case-sensitive). Not found = error, with a
  "did you mean" for a different letter case. Standard Lua (`string`, `table`, `os`, `pairs`...) is classified
  as standard Lua and never as GTPS API; `os.execute`, `io.*`, `load`... get a warning.
- **Parameters**: argument counts against the documented parameters (`Owner.method(self, ...)` and
  `Owner:method(...)` both accepted; a call ending in another call may expand).
- **Events and callbacks**: handler names and any `onXxx` string must be documented events/callbacks;
  handler parameter counts are compared with the documented ones.
- **Complete**: placeholder comments such as `-- ... rest of the code` fail the check.
- **Modification**: top-level parts of the original and the new script are compared (unchanged / changed /
  removed / added); a removed part is a warning.
- A method called on a value of unknown type is checked by member name only (variable types are not inferred),
  and calls that cannot be resolved are reported as "unverified" instead of being guessed.

`POST /api/lua/check` `{ code, original? }` runs the same check on any script.

### Script actions

Copy, Download .lua (name from the reply), Open in Lua Workspace (added as a unique file name), Explain Code
(answered from the documentation, nothing rewritten), Optimize, Refactor, Add Comments, Fix Errors (sends the
check's findings), Modify Script (asks what to change), Generate Alternative (a new script, not a diff against
the old one). All except Explain go through the generator, so documentation is retrieved and the new script is
checked again. Each reply has a **Generation report**: request type, topics searched with the number of excerpts
each found, topics with no documentation, and the check result.

### Tests

- `lua-parser.test.ts` (19), `lua-verify.test.ts` (20): parser and verifier units.
- `lua-generate.test.ts` (43): real client and handler, SQLite documentation, fake Gemini/Groq; asserts what the
  providers **received** for 8 requests, invented APIs/events, syntax errors, truncated and abbreviated scripts,
  modification preservation, missing documentation, provider switching, validation and `/api/lua/check`.
- `lua-chat-engine.test.ts` (14), `lua-actions.test.ts` (6), `tests/ui/generator-ui.test.tsx` (7).
- `tests/browser/generator.browser.ts` (16): real Chromium; generate, report, every action, download and clipboard,
  workspace, provider switch, reload.

### Verified and not verified

- The documentation is the **synthetic** fixture (`tests/support/gtps-lua-fixture.ts`, 16 invented pages): API names
  and behavior in it are not GTPS Cloud's. Retrieval for the seven script types was not run on the real
  documentation; topic queries and thresholds are tuned on the fixture only.
- Fake Gemini/Groq servers return scripted replies: the tests prove what is sent and what the app does with a
  reply, **not** that a real model writes correct GTPS Lua or follows the format.
- Verified against the documentation means "the name/parameters exist as indexed"; it does not mean the script
  runs correctly on a server. No Lua interpreter is available here, so scripts are never executed.
- Chromium tests use stand-ins for `zustand` (not installed in this environment, so workspace persistence in
  localStorage is not exercised), `next/navigation`, lucide icons and Tailwind utilities.

## Lua Workspace (Step 9)

Open **Lua Workspace** in the sidebar (`/workspace`). Files live in the browser's IndexedDB (database
`gtps-assistant-workspace`, stores `files` and `meta`); nothing is sent to a server except what you ask the AI to
work on.

### Editor

- **Monaco** (`@monaco-editor/react`, theme `vs-dark`, Lua language, line numbers, its own find/replace widget,
  one model and undo history per file). `@monaco-editor/react` downloads Monaco from a CDN at runtime
  (`loadMonaco`, 15 s timeout).
- **Automatic fallback**: if Monaco cannot be loaded the workspace switches to a basic editor and says why. The
  basic editor has line numbers (error lines in bold), Tab indentation, Ctrl/Cmd+S, and its own find/replace
  (Ctrl+F / Ctrl+H, match case, next/previous, replace, replace all). It has **no syntax colouring**.
- Both editors implement one interface (`EditorHandle`: selection offsets, replace range as one undoable edit,
  open find, reveal line), so the toolbar and the AI panel do not depend on which editor runs.
- Toolbar: Save (Ctrl/Cmd+S), Revert, Copy (the selection, or the whole file when nothing is selected),
  Download .lua, Find, Replace, Import, Export project, Import project, AI, Full screen (Esc leaves).
- **Unsaved changes**: a dot on the tab and in the file list, a badge in the toolbar. Saved text and unsaved
  text are stored separately: the unsaved text is written to IndexedDB 400 ms after you stop typing, so a reload or
  closing a tab never loses it and the file is still marked unsaved afterwards. Closing a tab keeps its unsaved
  text. With the memory fallback (no IndexedDB) the page warns that files are not kept and the browser asks to
  confirm leaving while edits are unsaved.

### Files

Create, rename (name sanitised to `snake_case.lua`, duplicates refused), delete (asks first), open, save, import
(`.lua`/`.txt`, up to 1 MB, UTF-8 only, no NUL bytes, BOM removed, CRLF turned into LF, existing files never
overwritten: a free name such as `main_2.lua` is used), export one file (includes unsaved edits), export and import a
whole project (`gtps-lua-project.json`, `format: gtps-lua-workspace`, `version: 1`). The first time the workspace
opens it creates `main.lua` (once: it does not come back after you delete it). Scripts saved by the Step 8
workspace in localStorage (`gtps-assistant:workspace`) are imported once, without its two placeholder files.
"Open in Lua Workspace" in the chat and the generator uses the same files. **Settings → Local Data** clears them.

### Three different kinds of checking (never mixed up)

1. **Syntax (local, as you type)**: the built-in Lua 5.1-5.4 parser (`src/lib/lua/parser.ts`). Errors are shown in
   the Problems panel (click to jump) and as editor markers. A clean result says "No syntax errors found", never
   "valid" or "works".
2. **Documentation check (on request)**: "Check against documentation" calls `POST /api/lua/check`: are the GTPS
   functions, parameters, callbacks used in the code in the indexed documentation? It goes stale (and says so) as
   soon as the code changes.
3. **GTPS runtime: not validated.** Scripts are never executed in this app. Every panel that shows a check says
   so; only a test on a real GTPS server shows that a script works.

### AI assistant

Explain, Fix, Optimize, Add comments, Refactor, Modify (asks what to change) and Generate (from a description).
They work on the **selection** when there is one, otherwise the whole file (the panel says which).

- Everything except Explain uses the backend's generator mode, which **always** searches the GTPS documentation
  and puts numbered excerpts and the documented API list in the prompt; Explain is a chat request with
  documentation search switched on. Documentation retrieval cannot be skipped from the workspace.
- A selection is sent as the script, with the surrounding lines as reference-only context; Fix also sends the
  local syntax errors inside the selection (and the current documentation findings for a whole file).
- The result shows a line **diff**, the documentation sources, the generation report and the script check. Apply
  as: replace selection / replace whole file / insert at cursor / save as new file. Apply is **refused** when the
  code changed after the request, and **disabled** when the reply was cut off inside the code block. One **Undo**
  restores the text from before the apply; Ctrl+Z also works in the editor. Nothing is applied automatically.
- Provider and model are chosen in the panel (default: the Settings defaults) and remembered. Keys stay on the
  backend.

### Tests

- `workspace-core.test.ts` (32): file naming, import rules, project file, controller (tabs, dirty tracking, save,
  drafts, rename/delete, import/export, storage failure, migration of stale ids), syntax check wording.
- `workspace-ai.test.ts` (28): prompts for a selection and a whole file, apply rules, diff, find/replace helpers,
  and the real round trip through the backend over the synthetic documentation: the provider **received** the
  numbered documentation excerpts for Modify, Explain and Generate; the check knows a selection is a modification;
  provider errors; cancellation; keys never in the prompt or the result.
- `tests/ui/workspace-ui.test.tsx` (8): tab bar, file list, Problems panel wording, diff.
- `tests/browser/workspace.browser.ts` (38) and `workspace-idb.browser.ts` (12): real Chromium and real
  IndexedDB: editor loading (and fallback on failure and on timeout), file creation/rename/delete, save and the
  unsaved indicator, multiple tabs, copy, download, import (file chooser, bad files, size limit), export,
  project round trip into a fresh browser profile, persistence after reload and after a browser restart, syntax
  problems, documentation check, full screen, AI Modify/Explain/Generate/Fix with the provider's received prompt
  asserted, refusal to apply stale results, errors.

### Verified and not verified

- **Real Monaco was not tested.** It is not installed in this environment and cannot be downloaded. In the
  Chromium tests `@monaco-editor/react` is replaced by a textarea that implements the part of the Monaco API the
  adapter calls (`tests/browser/support/monaco-react-stub.tsx`). Those tests prove the wiring (file switching,
  selection, applying edits, markers, find actions, Ctrl+S, line endings), **not** that Monaco highlights Lua, that
  its find widget works, or that markers render. `src/features/workspace/monaco-editor.tsx` has not been run
  against the real package or type-checked against its real types (it is written against structural types in
  `monaco-types.ts`).
- The basic editor and everything else are tested as themselves, in real Chromium.
- Tailwind cannot be built here, so the pages were exercised with a hand-written stand-in for the layout utilities:
  how the workspace looks and fits small screens was **not** verified.
- The documentation is the synthetic fixture and the AI replies come from scripted fake Gemini/Groq servers: the
  tests prove what is sent and what the app does with a reply, **not** that a real model gives good GTPS Lua.
- `.tsx` files cannot be type-checked here (`@types/react` is missing); `.ts` files are.
- Draft saving happens 400 ms after typing stops; a reload within that window can lose the last keystrokes.

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
    workspace/    Lua workspace engine: files, controller, IndexedDB/memory repositories, AI tasks, diff, find
  server/         Scraper, sync service + scheduler, SQLite layer, docs explorer, AI providers/service (server only)
  services/       Browser storage and scraper API client
  store/          Zustand stores (ui)
  types/          Shared TypeScript types
```

## Notes

- The Monaco editor loads its assets from a CDN at runtime; without internet access the workspace uses its basic
  editor (no syntax colouring).
- Settings and theme are stored in `localStorage`; chat history and Lua workspace files are in IndexedDB. Use
  **Settings → Local Data** to clear everything.
- Fonts use the system font stack, so builds do not depend on external font
  downloads.

## Roadmap

1. **Step 1:** project foundation and UI.
2. **Step 2:** documentation scraper and local SQLite storage.
3. **Step 3:** synchronization engine (incremental sync, scheduler).
4. **Step 4:** documentation explorer (hierarchy, FTS5 search, viewer, status).
5. **Step 5:** multi-provider AI integration (Gemini, Groq), settings, unified service.
6. **Step 6:** AI chat (streaming, history in IndexedDB, model selector).
7. **Step 7:** documentation-aware answers (retrieval, citations, context indicator).
8. **Step 8:** Lua script generator (documentation workflow, script check, actions).
9. **Step 9:** Lua workspace (Monaco editor, files in IndexedDB, AI assistant with documentation retrieval).
