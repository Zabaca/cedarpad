---
name: cedarpad-component
description: How to build components for the cedarpad canvas. Use when creating or editing canvas components (packages/canvas/src/canvas-components/, shared/components/, per-canvas components), or when debugging clicks, scrolling, or pointer events inside a canvas card.
---

# Cedarpad canvas components

A canvas component is a React file rendered inside a tldraw shape. The shape system
imposes non-obvious constraints — especially around pointer events — that have bitten
before. This skill records the contract and the traps.

## Where components live (ADR-0014 tiers)

Module name = file name (bare, no path). The loader resolves in order:

1. **Own**: `src/canvas-<canvasId>/components/<Module>.tsx` — per-canvas, agent-editable
2. **Shared**: `shared/components/<Module>.tsx` — workspace library (`@shared` alias); promote = pure file move, no store rewrite
3. **Base**: `src/canvas-components/<Module>.tsx` — read-only platform tier, baked into the image, checked into the repo

New platform components go in `src/canvas-components/`. See `src/component-loader.ts`.

## The component contract

- **Default-export** a React component. The shape's `data` object is spread as props.
- `ComponentHost` (in `src/ComponentShape.tsx`) injects **`setData(patch)`**: merge a
  patch into the shape's `data` — it syncs to collaborators and survives reload. Use it
  for any state that should persist; plain `useState` is per-tab and ephemeral.
- The component fills **100% × 100%** of the shape (`w`/`h` are shape props the user
  resizes). Root div: `width:'100%', height:'100%', boxSizing:'border-box'`.
- Render errors are caught by an error boundary → ErrorCard; loading is handled by the
  host. Don't build either yourself.
- Self-contained: no new dependencies. Inline styles, dark palette
  (bg `#11141a`, lines `#2a2e3d`, header bg `#0d1017`, text `#c9cdd6`, muted `#7a7f8c`),
  an `accent` prop defaulting to `#4a9eff` is the house pattern. Match the terse style
  of existing cards (`MarkdownCard.tsx`, `JsonCard.tsx`).

## Commands — editable data

A platform component whose `data` gets edited (a board, list, tracker) exports
`commands`: named `{ args: zod schema, run: (data, args) => nextData }` pure reducers.
The agent runs them with `call_component`, which reads the instance's LIVE data, so
concurrent edits survive; the UI calls the same `run` and passes the result to `setData`.
`Kanban.tsx` is the pilot. Loading goes through `server/component-commands.ts`, which
imports the file under Bun on the server, so no top-level `window`/`document` in a file
with commands. Unit-test every reducer in a plain `.test.ts` (`Kanban.test.ts`). The
authoring rules the chat agent follows are in
`platform-skills/skills/component-authoring/SKILL.md`.

## Pointer events — the #1 trap

`ComponentShape` (via `InteractiveBoxShapeUtil`) uses **capture-phase guards**: a
pointerdown/up only reaches your component if the event target matches
`isInteractiveControl` in `src/predicates.ts`:

```
button, input, textarea, select, a, label, [contenteditable=true], [role="button"]
```

Anything else bubbles to tldraw, which claims the pointer for select/drag — **the
browser never synthesizes a click**. Consequences:

- A plain `<div onClick={...}>` **silently never fires**. Use a real `<button>`/`<a>`,
  or add `role="button"` to the element.
- **Hover (`onMouseEnter`) still works** on unguarded elements — deeply misleading when
  debugging "click does nothing". Hover working proves nothing about clicks.
- Don't put `role="button"` on large containers: the card background must stay
  unguarded so clicking/dragging the card still selects/moves the shape.
- Wheel is always owned by the component (`wheel: () => true`), so internal scrolling
  works; the trade-off is a hovered non-scrollable card eats canvas zoom.

## Scrolling — never `scrollIntoView`

The card renders inside tldraw's **CSS-transformed (scaled) container**.
`element.scrollIntoView()` computes from transformed geometry and can also yank
ancestor scrollers — it does not work reliably here. Instead scroll your own container:

```tsx
// container needs position:'relative' so it is the headings' offsetParent
container.scrollTo({ top: Math.max(0, el.offsetTop - 8), behavior: 'smooth' });
```

`offsetTop` is pure layout, unaffected by transforms. See `scrollToHeading` in
`src/canvas-components/MarkdownCard.tsx`.

## Layout chrome

- The **top-right corner is reserved**: the shape renders a hover-revealed fullscreen
  button (`.component-expand`) there. Put your own chrome (toggles, menus) on the
  **left**, or in a header bar left of the title.
- If behavior depends on card width (e.g. auto-open a panel only when wide), measure
  once on mount via `ref.offsetWidth`. Remember the user can resize the shape.

## Seeing it render — the dev playground

`bun run dev`, then **http://localhost:$PORT/dev/playground.html?m=<Module>&f=<fixture>**
(`$PORT` is 4510 for a plain `bun run dev`; a worktree derives its own — see the
`worktree` skill).

A bench with no canvas around it: pick a module, pick a fixture, and the card renders with
that fixture as its `data`. `setData` is wired the way `ComponentHost` wires it (a patch
MERGES into `data`, it does not replace it), so the card's own controls work here exactly as
they do on a board; the right pane shows what `setData` has written, which is how you watch
view state while chasing a bug. The render box is `resize: both` — layout bugs live at odd
sizes, and the user resizes the shape.

- **Add a fixture** in `dev/fixtures.ts`, keyed by module then fixture name. A fixture is
  literally a placed instance's `data`. `none` is always offered and means no data at all —
  the unconfigured case every component has to survive.
- **Why not `?preview=<Module>`**: that renders one module inside the pad, but a preview
  passes **no `data`** by design. Any component driven by props renders empty there. Use
  preview to answer "does this module load"; use the playground to work on one.
- **It never ships.** The production build runs from `shell/vite.config.ts`, which does not
  know this entry. No flag, no dead code in the bundle.
- **It is not a type gate.** Modules load via `import.meta.glob` precisely so
  `src/canvas-components` stays out of the project typecheck (tsconfig excludes it
  deliberately). A component can render fine here and still have type errors — see
  "Typecheck reachability" below.

## Testing

From `packages/canvas` (never repo root): `bun run test`, `bun run typecheck`.

- **Pure logic**: export it (parser, derivation helpers) and test in a plain
  `.test.ts` — e.g. `tocEntries` in `MarkdownCard.test.ts`.
- **DOM behavior**: happy-dom harness. `import './happydom-harness.ts'` must be the
  FIRST import; render with `createRoot` + `act`, interact with `.click()`. Exemplars:
  `src/json-card.test.tsx`, `src/markdown-card.dom.test.tsx`.
- **Pin guard compatibility**: for anything clickable, assert
  `isInteractiveControl(renderedEl) === true`. This is the test that catches the
  silent-click-loss bug class.
- happy-dom has **no layout**: everything measures 0 (`offsetWidth`, `offsetTop`).
  Width-dependent defaults won't trigger — drive the UI through its controls instead —
  and stub `offsetTop`/`scrollTo` with `Object.defineProperty`/assignment to test
  scroll wiring.
- **Typecheck reachability**: a base component nothing imports may be invisible to
  `tsc` until a test imports it — new type errors can surface only then (e.g. React 19
  `cloneElement` needs the element typed as
  `React.ReactElement<{ ref?: React.Ref<T> }>` to accept a `ref` prop). Always give a
  component at least one importing test, and check typecheck's real exit code, not
  just its output.

## Paste integration (optional)

To make pasted content materialize as your component, add detection in
`src/paste-detect.ts` and a module mapping (module name, initial `data`, default w/h)
in `src/paste-place.ts` — e.g. pasted markdown → `MarkdownCard`.
