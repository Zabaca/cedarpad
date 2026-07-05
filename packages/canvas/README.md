# agent-canvas

ONE application, two surfaces behind one login:

- **Canvas** — a tldraw canvas with a built-in **chat agent** (Claude, via the
  **Claude Agent SDK**) that draws on it and reads from it. See
  [`CONTEXT.md`](./CONTEXT.md) for the normative model.
- **Notebook** — the Problem/Solution intelligence app (React SPA
  `src/notebook/` + Hono `/v1` API `server/notebook/`, Turso + Voyage
  embeddings). Domain docs in [`docs/notebook/`](./docs/notebook/).

The far-left rail switches between them.

## Run it

```bash
bun install            # from the repo root
cd packages/canvas
bun run dev            # bridge :4511, web :4510, extension server :4512
# open http://localhost:4510
```

`bun run dev` starts the bridge (canvas store + agent + the mounted notebook
API), the vite web app, and the extension server. Vite proxies `/api/*` and
`/v1/*` to the bridge, so you only ever open `:4510`.

### Auth

**Signing in**: the app is gated by a Better Auth email/password login — you land
on the login screen until you have a session; both surfaces (canvas + notebook)
sit behind it. In local dev, sign up on the spot (signup is disabled in
production via `AUTH_DISABLE_SIGNUP=1`). The bridge enforces the session on all
canvas `/api/*` routes; notebook's `/v1/*` also accepts an API key
(`x-api-key`) — see [`docs/notebook/API_ACCESS.md`](./docs/notebook/API_ACCESS.md).

**The agent** runs through the Claude Agent SDK, which uses your local Claude
Code credential (subscription login or `ANTHROPIC_API_KEY`). If you're logged
into Claude Code, it just works. Override the model with `CANVAS_MODEL` (default
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
bun run typecheck      # tsc, clean (one project: src, server, shared, scripts, lib)
bun run test           # bun test server src lib — canvas + notebook suites
```

The store, the agent tool logic, the bridge HTTP/SSE sync (both directions), and
a real-browser walk of the tldraw render + sync were all verified during the
build. The one thing tests can't cover is the live model call — that needs your
auth, exercised by actually chatting.

## Notes

- **Deploy**: one Cloudflare Worker (`agent-canvas`) + container running this
  dev stack (vite is the runtime compiler — ADR 0001). `bun run deploy` — only
  with explicit approval (see `CLAUDE.md`). Canvas state persists to R2;
  notebook data to Turso. Local dev persists canvas state to `.persist/` and
  notebook data to `.notebook-dev.db`.
- **Deploy ops**: `GATE_SECRET` is only the `x-ops-key` header for `/__recycle`
  and `/__bootlog` (used by `scripts/deploy.sh`). There is no user-facing gate
  key — login is the gate.
- The canvas shows a tldraw **non-commercial watermark** until a production
  license key is added.
