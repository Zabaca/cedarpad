# app-mock-branches

**Variant B of three** — a pure visual mock of cedarpad's UI.

This is one of three parallel mock frontends being built for early feedback. There is no backend, no Claude calls, no DB — every Block, Thread, and Node is hardcoded in `src/fixtures.ts`.

## What makes this variant distinct

In Variant B, **branching is the hero**. The moment a user forks a Thread is the moment the UI is designed around: "I have two ideas; let me explore both, side-by-side, without losing either."

Distinctive choices:

- **Sibling Threads under a Thread Root render as side-by-side columns**, not stacked vertically. Three Threads visible at once for the featured Thread Root.
- **Active vs. inactive branch styling** — the focused Thread is full-color and ring-highlighted, siblings are muted. Click a column to focus it.
- A **branch graph mini-map** in the bottom of the sidebar shows the full fork structure under the current Thread Root.
- A **prominent "Branch" button on every Block** — not hidden in a hover menu. Retry from here and New thread sibling live in a small ⊕ menu next to it.
- A **"Compare branches"** affordance in the breadcrumb hints at side-by-side diff (out of scope for the mock).

Visual direction: Linear-ish — cards, padding, subtle dividers, indigo brand accent, sans-serif (Inter). Light theme by default with a dark-mode toggle.

## Visual coverage

All seven items from the brief are visible:

1. Workflowy-style outline of Content Nodes — sidebar, with indentation, completion strikethrough, and a "Start Thread" sparkle on hover.
2. Thread Root visually distinct from Content Nodes — left brand-color stripe, GitBranch icon, "N threads" badge.
3. A Thread with one Turn — human prompt bubble + Turn Node container + Block Node children (text, tool_use, tool_result), each with kind-coded coloring.
4. **Three sibling Threads under one Thread Root, displayed as parallel columns** (plus a "New thread sibling" placeholder column).
5. **Branch / Retry from here / New thread sibling** — Branch as a visible button on each Block; Retry and New sibling in a small popover. New thread sibling also available as a placeholder column.
6. Workspace switcher — Cmd/Ctrl+P toggles a command-palette-style modal showing 4 fake recent workspaces.
7. Keyboard hints — always-visible footer; press `?` for the full overlay.

## Run

```sh
bun install
bun run dev
```

Default port is **5176** (distinct from other mock variants). Override via `PORT=...`.

## Stack

- Vite + React + TypeScript
- Tailwind CSS
- `lucide-react` for icons
- Bun for install/dev

## Worktree-safety

- `vite.config.ts` reads `PORT` from env (default 5176, distinct from other mocks). No hardcoded port collisions.
- This package is fully self-contained under `packages/app-mock-branches/`.
