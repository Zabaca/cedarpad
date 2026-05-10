# @cedarpad/app-mock

A **pure visual mock** of the cedarpad UI. Independent of (and parallel to) the
real Slice 1 implementation — built so you can preview what we're targeting and
form an opinion before any of it is wired up.

## Run

```sh
cd packages/app-mock
bun install
bun run dev
```

Opens at `http://localhost:5174` by default. Override with `PORT=…`.

## What's there

- A Workflowy-style outline of **Content Nodes** with nesting and a faux cursor.
- A **Thread Root** (highlighted Content Node) with two sibling **Threads**
  beneath it — what branching produces, side-by-side.
- One Thread contains a user prompt (Content Node) and a **Turn Node** with
  three flavours of **Block Node** children: `text`, `tool_use` (e.g. `Read`,
  `Grep`), and `tool_result` — each visually distinct.
- Hover any Block to reveal the three **branch verbs**: `Branch`,
  `Retry from here`, `New thread sibling`.
- `Cmd+P` (or click the workspace name in the header) opens a workspace
  switcher palette listing fake recent workspaces.
- `?` (or click the help icon) opens a keyboard hints overlay; the footer
  surfaces the most common bindings inline.

## What's *not* there

This is a mock. None of the following work:

- Persistence, libSQL, anything DB-shaped
- Claude integration (no SDK, no API calls, no streaming)
- Real keyboard handling beyond `Cmd+P` / `?` / `Esc`
- Drag-reorder, search, zoom-into-Node
- Tauri packaging
- Tests
- Mobile / responsive layout

The outline data lives entirely in `src/fixtures.ts`. Edit there to
explore alternative visual states.

## Stack

Vite + React + TypeScript + Tailwind. `lucide-react` for icons. No other UI
deps — no Radix, no shadcn, no Storybook.

## Worktree-safety

Per `CLAUDE.md` §6: the dev server reads `PORT` from env (default `5174`,
chosen to avoid collision with the real Slice 1 dev server on `5173`). Nothing
else here is stateful, so there's nothing else to namespace.
