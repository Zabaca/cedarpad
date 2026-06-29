# place_component: make the initial arrow linkage source controllable

**Status:** open / backlog
**Filed:** 2026-06-26

## Problem

When the agent places a new component instance via `place_component`, the tool
**always** auto-draws an arrow from the **chat card** to the new instance. There is
no way to choose a different link source at creation time.

This matters for variation/lineage workflows: when generating variations *off a
selected source node* (e.g. four restylings of "Variant 2"), the arrows should run
`source -> variation`, not `chat -> variation`. The arrow graph is the lineage, so
flattening everything onto the chat card destroys the exploration tree.

(See memory: `feedback_canvas_link_off_selected`.)

## Current workaround

Let `place_component` create the `chat -> component` arrow, then **delete that arrow
and re-create** `source -> component` with `create_shapes`. Works, but it's an extra
2 tool calls per placement and easy to forget.

## Where it lives

- `src/canvas-ops.ts`
  - `placeComponentOp()` (~line 285) — calls `linkRootsToChat([shape], originChatId)`
    at line 309 (the coords-honored branch) and `tuckBesideChat()` at line 312 (the
    no-coords branch). Both hard-wire the link to `originChatId`.
  - `linkRootsToChat()` (~line 129) — builds the arrow with `startShapeId: chatId`.
  - `PlaceComponentInput` interface (~line 273).
- `server/agent.ts`
  - `place_component` tool schema (~line 211) and its handler (~line 223) which passes
    the input through to `placeComponentOp(..., originChatId)`.

## Proposed fix

Add an optional `linkFrom` (shape id) param to `place_component`:

- Schema: `linkFrom: z.string().optional().describe('Shape id to draw the creator arrow FROM. Defaults to the chat card. Pass a source node to branch variations off it.')`
- Thread it into `PlaceComponentInput`.
- In `placeComponentOp`, when `linkFrom` is set, use it as the arrow start instead of
  `originChatId` (in both the coords-honored and auto-tuck branches). Update the
  returned `where` text accordingly (e.g. `linked to <id>`).
- Optional: support `linkFrom: null`/`"none"` to place with **no** auto arrow at all.

## Acceptance

- `place_component({..., linkFrom: '<sourceId>'})` creates exactly one
  `source -> instance` arrow and no `chat -> instance` arrow.
- Omitting `linkFrom` preserves today's behavior (links to chat).
- Update `src/component-ops.test.ts` to cover both paths.
