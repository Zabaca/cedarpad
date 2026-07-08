# Workspace platform: an edge Shell over one container of many canvases, apps as surfaces

cedarpad becomes a multi-app platform: a **persistent edge Shell** (the app frame: rail +
workspace switcher + canvas selector + login) fronts **per-workspace runtime containers** — James may have
many workspaces (e.g. one per repo/project), each a container hosting **many canvases**
(one vite serving per-canvas component dirs) plus the agent runtime — while **Notebook**
runs as a pure **edge + Turso** app and **continuous dev workflows** run in a **separate
sandbox instance**. This inverts today's arrangement, where the frontend (and, per PR #40,
a rail-menu of apps) is served *inside* a single-canvas container. **Single-tenant
(James-only); multi-tenant is deferred** (it reopens ADR-0001's unsandboxed-RCE stance).

Status: accepted. **Amends canvas [ADR-0001](../../packages/canvas/docs/decisions/0001-cloudflare-container-deploy.md)** —
the container deploy, vite-as-compiler, and R2 persistence stand; its "one workspace / one
canvas", "shell served by the container", and "Cloudflare Access maps identity → container
as the gate" stances are replaced below. Target model; not yet built. Full vocabulary in
the root [CONTEXT.md](../../CONTEXT.md).

## Decision

```
Edge Worker
├─ Shell SPA    served from ASSETS at `/`; the ONE chrome (rail + workspace switcher +
│               canvas selector) that mounts Canvas/Notebook/Inbox as inline stages;
│               runs Better Auth (→ Turso); the single gate; never wakes a container
├─ Notebook     Hono API → remote Turso + Voyage embeddings; static SPA (edge, no container)
└─ proxy        /w/:ws/canvas/:id/pad → the container(s), only after auth — the iframed
                Render Pad is the SOLE container-wake trigger

Product container  (one PER workspace; James switches workspaces in the Shell; sleeps @5m)
├─ one vite    serves per-canvas dirs canvas-<id>/components/ (isolated by path)
├─ shared/components/   live workspace library (@shared); "promote" moves a component here
└─ bridge       N CanvasStores (keyed by canvasId) + Claude Agent SDK (canvas / notebook / inbox chats)
   (per-workspace sandbox ID + R2 prefix `workspaces/<ws>/…`)

Dev-agent sandbox (same image, own sleep schedule)
└─ scheduled workflows → git worktree of Zabaca/cedarpad → PR; promote an Inbox Conversation

Inbox = coordinator over Sessions (agnostic to where a Session runs)
   Session (atom: SDK sessionId + transcript) → home: Canvas chat | Conversation
   Conversation: status open|closed · waiting-on human|agent|none · unread
```

- **Shell at the edge, not in the container.** The Shell is the **persistent app frame** —
  an edge-served SPA that owns the rail, the workspace switcher, and the canvas selector, and
  mounts Canvas, Notebook, and Inbox as **inline stages** (`?stage=…`, `pushState`/`popstate`),
  never as separate full-page loads. It must be instant and must wake the runtime on demand;
  serving it from the sleepy paid container would re-pin the very sleep problem the container
  is tuned to avoid. The edge Shell serves login/UI and proxies to the container **only after
  auth**. _(Amended by PRD #103: the original "launcher + top nav that navigates away to
  `/notebook` and `/inbox`" is now one persistent frame with inline stages; `/notebook` and
  `/inbox` survive only as redirects into the matching stage.)_
- **The canvas stage mounts the Render Pad in a same-origin iframe, and that is the ONLY
  container-wake trigger.** The stage lists canvases (`/api/canvases`, served at the edge) and,
  on selection, iframes `/w/:ws/canvas/:id/pad`. This *strengthens* the no-wake stance above:
  browsing the rail — Notebook, Inbox, the canvas list — never touches the container; only
  mounting the pad iframe does. **Same-origin** (`poc.cedarpad.com`) means the Better Auth
  cookie flows into the frame with **no token handoff**, and a cold-booting or crashed
  container degrades **inside the iframe frame** while the shell around it stays live.
- **Chat stays inside the Pad — no `postMessage` protocol.** Chat is about the canvas, so it
  lives in the pad alongside the canvas it acts on; the shell stays dumb navigation and v1
  needs zero shell↔pad message protocol.
- **The tldraw pages layer was removed** (PRD #103): the hierarchy is now `Workspace →
  Canvases → Canvas → Render Pad`, with no `pageId` on shapes and no `pages` in canvas state.
  Recorded here because it is hard to reverse and it settled the platform hierarchy this ADR
  governs, though it began as a canvas-internal simplification.
- **One container, many canvases.** The workspace runtime is a single container hosting a
  **single vite** that serves per-canvas component dirs (`canvas-<id>/components/`, isolated
  by import path) plus a workspace-level **shared component library** (`@shared`, live,
  import-by-reference; promoting moves a component into it and edits propagate to every
  canvas that placed it). One sleep timer, one paid instance. **(Revised from "a vite dev
  server per open canvas" during #53 implementation — per-canvas vite processes multiply the
  container cold-boot/sleep cost and add worker-side per-port routing, whereas
  `component-loader` imports by path, so a path prefix delivers the same per-canvas isolation
  with one server.)**
- **Canvas is a workspace-owned surface, not owned by the Canvas app.** It carries an
  optional owner edge (none / a Notebook item / an Inbox session). All canvases are indexed
  by the Canvas app regardless of owner; **owner-delete orphans, never cascades**.
- **Notebook is an edge app.** It needs no vite compiler and no agent runtime for its core
  loop, so its Hono API runs on the Worker against remote Turso and its SPA is a static
  build. Carries over PR #40's contract, Drizzle schema, and embeddings pipeline; drops
  PR #40's in-container mount + in-app `Gate`.
- **Continuous dev workflows run in a separate sandbox instance** (same image, own
  schedule) so they never pin or get reaped by the product container's sleep timer. Edits
  land as PRs from a git worktree (a baked, non-git `/app` edit would evaporate).
- **Better Auth at the edge is the single gate; `cs_gate` is removed.** Because the edge
  serves the login and only proxies post-auth, the pre-auth source-disclosure hole that made
  `cs_gate` mandatory closes structurally. Cloudflare Access becomes optional
  defense-in-depth, not a dependency.

## Why

- The product is no longer one app. Item-2 of the platform vision needs a shell that
  *launches* apps (Canvas, Notebook, Inbox) — it cannot itself be a tenant of the app it
  launches.
- Separating by **lifecycle** is the real lever: an aggressively-sleeping product runtime
  and an always-on background dev agent want opposite sleep policies, so they must not share
  one timer. (The git-durability concern is orthogonal and solved by clone→PR.)
- Reuses hard-won work: the container sleep/cold-boot model (ADR-0001 + the container-sleep
  fixes), PR #40's Notebook internals, and PR #40's Better Auth — while removing PR #40's
  coupling (Notebook-in-container, in-app gate).

## Trade-offs accepted

- **More surfaces to operate**: an edge Worker, per-workspace product containers, and a
  dev-agent sandbox, vs one container. Mitigated by the dev-agent reusing the product image
  and by aggressive sleep — cost scales with *active* workspaces, not total (idle ones sleep).
  `max_instances` must rise above the current `1`.
- **Cross-canvas breakage from the live shared library**: editing a shared component can
  break multiple canvases at once. Accepted at single-user scale; the existing per-instance
  error boundary contains it, and a canvas can copy a component back to diverge.
- **The bridge holds N `CanvasStore`s** (keyed by `canvasId`) in one process; per-canvas
  component dirs are served by the single vite (path-isolated), so there is no per-canvas
  process to start/stop.
- **Auth is now our code to run at the edge** (Better Auth in the Worker) rather than a
  managed gate. Accepted for app-level user records and portability.

## Rejected alternatives

- **One container per canvas** — multiplies the cold-boot/sleep/paid-instance problem per
  canvas; rejected in favor of one workspace runtime hosting many canvases.
- **Shell served by the container** (PR #40's rail menu) — couples shell availability to
  the runtime's sleep state and keeps the `cs_gate` hole open.
- **Run the continuous dev workflow in the product container** — its edits to the baked
  `/app` are non-git and evaporate on recycle, and it fights the product sleep timer.
- **Merge PR #40 as-is** (Notebook embedded in the container) — re-entrenches the coupling
  this ADR removes; we adopt the crux and re-home it instead.
- **Cloudflare Access as the gate** — its headline benefit (closing the pre-auth hole) is
  neutralized by the edge-Shell topology, and it yields an identity header rather than
  app-level user records. Kept as optional hardening.

## Resolved fast-follows (see CONTEXT.md for detail)

- **Promote-to-inbox protocol**: checkpoint-and-resume (async). `ask_human` sets
  `waiting-on: human` + notifies, agent commits + ends turn (runner may sleep); my reply
  resumes the Session via `sessionId`.
- **Inbox storage**: Turso holds Conversation metadata + list preview; the SDK session
  JSONL (`~/.claude/projects/<sessionId>/`) is backed up live to R2 and restored on wake
  (read history from R2 while asleep; restore before `resume`).
- **Workflow cadence**: scheduled off-hours with a quality gate — promote only when there
  are candidates worth raising; skip anything already declined (ADR/marker).
- **Scope**: **multi-workspace, single-tenant** — James may have many workspaces (each a
  per-workspace container + R2 prefix), switched in the Shell. Canvas/Notebook data are
  per-workspace; the Inbox is one user-scoped aggregate (Conversations tagged `workspace_id`).

## Still deferred

**Multi-tenant** (other people sign up): requires tenant isolation, per-user limits/billing,
and a fix for the unsandboxed-RCE-per-signup problem before any non-James user touches a
container. Its own future step; reopens ADR-0001's core safety assumption.
