# agent-canvas

A tldraw canvas with a built-in **chat agent** that draws on it and reads from it.
You sketch by hand; you also ask the agent (Claude, via the **Claude Agent SDK**)
to create / edit / arrange shapes, and it sees whatever you've drawn. Layer-3
product POC — see [`CONTEXT.md`](./CONTEXT.md) for the normative model.

## Run it

```bash
bun install            # from the repo root
cd packages/canvas
bun run dev            # bridge on :4511, web on :4510
# open http://localhost:4510
```

`bun run dev` starts both the bridge (canvas store + agent) and the vite web app.
Vite proxies `/api/*` to the bridge, so you only ever open `:4510`.

### Auth

The agent runs through the Claude Agent SDK, which uses your local Claude Code
credential (subscription login or `ANTHROPIC_API_KEY`). If you're logged into
Claude Code, it just works. Override the model with `CANVAS_MODEL` (default
`sonnet`).

## Try

- *"Draw a 3-step login flowchart with arrows."*
- *"What's on the canvas?"* (after you've sketched something by hand)
- *"Make the Start box red and move it to x=100."*
- *"Align those three boxes left."*
- *"Chart our TAM: SAM $250M, full TAM $2.85B."* (renders a live custom component)

The agent's shapes appear **live** while its reply streams in the chat panel.

## What the agent can do

Tools: `read_canvas`, `view_canvas` (PNG screenshot), `create_shapes` (batch),
`update_shapes` (move / resize / recolor / relabel), `delete_shapes`, the
component-library tools (`list_components`, `read_component`, `write_component`,
`edit_component`, `place_component`, `set_component_data`), `clear_canvas`,
`align_shapes`. It authors rectangles, ellipses, text, sticky notes, and arrows in
8 colors. Freehand pen strokes are yours alone — it can read them but not draw
them. The agent's file access is scoped to the component library.

**A reusable component library.** For anything the fixed shapes can't express —
charts, tables, KPI cards, dashboards — the agent builds **real React files** under
`src/canvas-components/` and places instances of them on the canvas. They're
ordinary modules: they **compose** (`import KpiCard from './KpiCard'`), take
**data** (props), and import real npm deps (e.g. `mermaid`). vite compiles each
file; the canvas dynamic-imports it and re-imports live when the agent edits it.
Seed library: `KpiCard`, `Dashboard` (composes `KpiCard`), `MermaidDiagram`. Each
instance renders in an error boundary (a bad component shows a red card, never
crashes the canvas). See CONTEXT.md "Custom components" for the design and the
dev-server / security tradeoff.

## Design system

The visual system is **normative in [`DESIGN.md`](./DESIGN.md)**: the cedar token set
(warm-graphite neutrals + one Cedar Ember accent that means *live*), typography,
elevation, and component rules. [`PRODUCT.md`](./PRODUCT.md) holds the strategic frame
(who it's for, anti-references, principles); [`.impeccable/design.json`](./.impeccable/design.json)
is the machine-readable sidecar (tonal ramps, shadow/motion tokens, component
specimens). The live token values are `src/styles.css` `:root`; the app chrome and any
new `src/canvas-components/*` conform to them. Iterate the system with the `impeccable`
skill (`document` / `critique` / `polish`).

## Verify

```bash
bun run typecheck      # tsc, clean
bun test               # store + canvas-ops invariants
```

The store, the agent tool logic, the bridge HTTP/SSE sync (both directions), and
a real-browser walk of the tldraw render + sync were all verified during the
build. The one thing tests can't cover is the live model call — that needs your
auth, exercised by actually chatting.

## Notes

- **Local-only, in-memory.** No backend DB; a reload starts from an empty canvas.
  The whole point is the cross-process bridge (browser ↔ agent) on your machine,
  so there's no Vercel deploy.
- The canvas shows a tldraw **non-commercial watermark** until a production
  license key is added.
