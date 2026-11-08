# GTPS Assistant

An AI-powered development assistant for GTPS Cloud developers.

> **Status: Step 1, UI foundation only.** The app shell, navigation, and page
> layouts are in place. There is **no AI provider, no documentation scraper,
> and no Lua generator yet**. Controls that depend on them are disabled and
> labelled as unavailable.

## Tech stack

- Next.js 15 (App Router) and React 19
- TypeScript (strict)
- Tailwind CSS 3 with shadcn/ui-style components (Radix primitives)
- Lucide icons
- Zustand for state (persisted to `localStorage`)
- Monaco Editor (`@monaco-editor/react`) for the Lua workspace

## Requirements

- Node.js 20 or newer
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
  services/       Browser storage service
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

1. **Step 1 (this step):** project foundation and UI.
2. Later steps: documentation ingestion, AI provider integration, Lua
   generation.
