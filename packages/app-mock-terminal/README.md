# `@cedarpad/app-mock-terminal`

**Variant C of three** parallel visual mocks of the cedarpad UI. This is
the **terminal / dev-tool aesthetic** — pure CSS, hardcoded fixtures,
no backend, no Claude calls, no persistence. Pixels only.

Other variants live at `packages/app-mock/` and
`packages/app-mock-branches/`.

## What this variant explores

cedarpad's product story is "replace the terminal." Variant C takes that
literally: cedarpad rendered as if it were a TUI in a browser.

- **JetBrains Mono everywhere**, dark theme by default
- **ANSI-flavoured palette** — green / cyan / yellow / magenta / muted
  gray on a near-black background
- **Flat and dense** — no cards, no shadows, no rounded corners
- **Tool calls as `$ Read …` prompts**, tool results as indented `pre`
  blocks below the call
- **Vim-style status line** at the bottom — `NORMAL` mode pill,
  workspace path, current thread, and a row of single-letter key hints
  (`j/k`, `o`, `b`, `r`, `n`, `Tab`, `⌘P`, …) visible at all times
- **No popups for the action menu** — Branch / Retry / New thread sibling
  hang inline under the selected Block in a terminal-style strip
- **Sibling threads** are rendered as a side-by-side split inside the
  Thread Root (terminal-tile feel, not card-feel)
- **Cmd+P / Ctrl+P** opens a fuzzy palette with ANSI-yellow highlighted
  matched characters

The 60-second feel test: after looking at it, an engineer should think
"oh, this is what a *power-user* version of cedarpad would feel like."

## What you'll see (PRD coverage)

1. Workflowy outline of Content Nodes (terminal `•` markers, depth rail)
2. Thread Root — magenta `▼ thread:` heading, visually distinct
3. A Thread with one Turn — prompt + Turn header + text/tool/result Blocks
4. Sibling threads — `thread/main` and `thread/alt` side-by-side
5. Branch / Retry / New thread sibling — inline action menu under the
   selected Block + key hints in the status line
6. Workspace switcher — Cmd+P palette with monospace fuzzy match
7. Bottom status line with key hints visible at all times

## Run it

```bash
cd packages/app-mock-terminal
bun install
bun run dev          # PORT defaults to 5177; override via PORT=… per CLAUDE.md §6
```

Then `Cmd+P` (or `Ctrl+P`) to see the workspace switcher.

## Stack

- Vite + React + TypeScript
- Plain CSS (no Tailwind — the aesthetic is the styling)
- JetBrains Mono via Google Fonts CDN; falls back to
  `ui-monospace, "Cascadia Code", "Source Code Pro", monospace`
- Bun for install/dev

## Out of scope (for the mock)

Real persistence, libSQL, Claude SDK, Tauri, real keyboard handlers
beyond the demo affordances (Cmd+P, Esc, ↑↓ in the palette), drag
reorder, real search, zoom, tests. See issue #1 for v1 scope and
`packages/app/CONTEXT.md` for the domain glossary the mock illustrates.
