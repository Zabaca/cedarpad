# Workspace platform — domain model (normative)

> **Status: target model, being designed** (grill session started 2026-07-07). Not
> yet built. This is the workspace-level frame that sits *above* the individual
> apps. It supersedes the single-container / single-canvas framing in
> [canvas/CONTEXT.md](./packages/canvas/CONTEXT.md) + ADR-0001 once implemented.
> Per-app internals stay in each app's own `CONTEXT.md`.

## Runtime & frames

**Workspace**: an isolated runtime — one Cloudflare Container, its own filesystem, its own
R2 prefix (`workspaces/<ws>/…`, already keyed this way in ADR-0001), its own sleep timer.
James may have **many** workspaces (e.g. one per repo/project), switched in the Shell; each
gets its own per-workspace sandbox ID + R2 prefix. Within a workspace it's still one
container hosting N canvases + one shared component library (the "one container, N canvases"
model applies *per workspace*). **Single-tenant (James-only)** — no other users — so
ADR-0001's "unsandboxed RCE is acceptable because it's just me" stance still holds.
**Multi-tenant (other people sign up) is deferred** to its own step (it reopens that RCE
safety stance). _Avoid_: "sandbox", "instance".

**Shell**: the top-level launcher + top nav, served **statically at the edge** (the
Worker), NOT inside the container. Always instant; wakes the workspace runtime only
when you open an app or canvas. **Owns login and is the single gate**: the edge Shell
Worker runs **Better Auth** (against Turso) for the Shell, the container proxy, and
Notebook's `/v1/*` — one auth system. Because the edge serves the login/Shell and only
proxies to the container *after* auth, the old pre-auth source-disclosure hole closes
structurally, so **`cs_gate` is removed** (Cloudflare Access becomes optional
defense-in-depth, not a dependency). This word was formerly the name of the canvas
frontend frame — that is renamed **Canvas Frame** to free it.
_Avoid_: calling the canvas frontend frame "shell".

**App**: a launchable surface in the Shell's top nav. Three:
1. **Canvas** — index of all canvases (see below).
2. **Notebook** — Observations + Problems (PM), knowledge graph. From PR #40.
3. **Inbox** — Human-in-the-loop: Claude sessions that need my attention.

Each app has its own document model, in its own `CONTEXT.md`.

**Scoping across workspaces** (given James has many): **Canvas** and **Notebook** data are
**per-workspace** — a workspace's canvases and its Observations/Problems belong to that
workspace (Turso rows carry `workspace_id`). The **Inbox is user-scoped** — one attention
inbox for James, aggregating Conversations across all his workspaces, each Conversation
tagged with its `workspace_id` (filterable by workspace). The **dev-agent workflow maps to
a workspace's repo**: a per-repo workspace's scheduled `/improve-codebase-architecture`
runs against that workspace's `Zabaca/…` repo and promotes into the one user Inbox.

## Canvas as a shared surface (not owned by the Canvas app)

**Canvas**: a workspace-owned drawing surface — its own pages and its own component
dir (isolated by path, served by the workspace's single vite). It is NOT property of the Canvas app.
It carries an optional **owner** edge:

- `none` — standalone.
- a **Notebook** item (Observation/Problem).
- an **Inbox** session.

Rules:
- The **Canvas app** is the *index* over ALL canvases regardless of owner; each shows
  an origin badge ("from Problem #12", "from session ‹x›"). A canvas can never be lost.
- Notebook/Inbox creating a canvas only sets the owner pointer; the canvas still lives
  in the one registry and the one runtime.
- **Owner-delete orphans, never cascades.** Deleting the owning Problem/session drops
  the pointer; the canvas survives as standalone. Closed session ≠ deleted canvas.

Mirrors the canvas glossary's own shape: a `chat` is a shape *on* a canvas; here a
canvas is a surface *on* a notebook item or session — an attachment edge, not a copy.

**Components & the shared library** (runtime revised during #53 — see note):
- Each canvas has its own component dir (`canvas-<id>/components/*.tsx`), isolated **by
  path**, served by the workspace's **single vite** (not a per-canvas vite process —
  `component-loader` imports components by path, so a path prefix gives the isolation
  without N servers; a per-canvas vite was rejected because it multiplies the container
  cold-boot/sleep cost).
- The workspace has one **shared component library** (`shared/components/`) that the vite
  resolves via an `@shared` alias. **Promote** = move a component from a canvas's own dir
  into the shared library.
- A placed instance references a component by its **bare module name**; the loader resolves
  **own-dir first, then `@shared`**. So promote is a pure file *move* — no store rewrite, and
  placed instances stay byte-stable — while a component placed on another canvas by the same
  bare name resolves to the one shared source. Adopting (copy-back) reintroduces an own-dir
  file that shadows the shared one (own wins), which is how a canvas diverges.
- Shared components are a **live single source, imported by reference**: new canvases see
  them automatically, existing canvases see them too, and editing a shared component
  rev-bumps + hot-reloads every canvas that placed it (extends today's per-canvas
  `bumpAllComponents` to a workspace-level signal). A broken
  edit is isolated per-instance by the existing error boundary; a canvas that needs to
  diverge copies the component back into its own dir.

(Canvas-internal model — pages, shapes, components, core/extension split — stays in
[canvas/CONTEXT.md](./packages/canvas/CONTEXT.md).)

## Apps — stubs (filled as we design)

**Notebook**: PM ("Problem/Solution intelligence") app. **Edge + Turso, not a container
tenant** — it needs no vite compiler and no agent runtime for its core loop, so its Hono
API runs on the Worker against remote Turso and its SPA is a static build served under
the Shell. Carries over PR #40's crux: the zod-openapi **contract**, Drizzle **schema**,
and **Voyage embeddings / cosine-similarity** pipeline. Drops PR #40's in-container mount
+ in-app `Gate` (the edge Shell owns login). Domain rollout: **Observation** (capture →
embed → similarity) is the beachhead; **Problem** then **Solution** + graph-synthesis
follow. (Full domain model: [packages/canvas/docs/notebook/CONTEXT.md](./packages/canvas/docs/notebook/CONTEXT.md),
to be re-homed.)

**Inbox** (Human-in-the-loop): Intercom-style inbox of Claude sessions.

- **Session**: the atom — one Claude Agent SDK conversation (`sessionId` + transcript).
- A Session has a **home**: a **Canvas chat** (a `chat` shape, canvas app) OR an **Inbox
  Conversation** (inbox app). "Conversation" is deliberately Intercom's word, to avoid the
  canvas glossary's `session = chat` collision.
- **Conversation** = Session + inbox state (open/closed, read/unread, needs-attention,
  last-activity). May own a Canvas (the owner edge above).
- Inbox membership is **explicit**: a canvas chat does NOT auto-appear in the Inbox — it
  shows up only if I start it there or an agent promotes it. So background-agent items
  aren't drowned by every little canvas chat.
- **State model** (two axes):
  - `status`: `open | closed` — closed = archived, filtered out of the default inbox.
  - `waiting-on`: `human | agent | none` — `human` = needs my attention.
  - `unread`: new agent activity since I last looked.
  - Default inbox view = `status:open`, sorted by last-activity; `waiting-on:human`
    pinned at top. Agent can promote (open + waiting-on=human + notify), post activity
    (unread), and self-close. I can read, reply (waiting-on→agent), close, reopen.
- Populated by sessions I start there and by **background agents that promote their
  session when they need my attention** (first such agent: an always-running
  `/improve-codebase-architecture`).

**Storage**: **Turso** holds Conversation metadata (status, waiting-on, unread,
last-activity, owner edge, `sessionId`, summary, user) + a denormalized last-message
preview so the inbox list is fast. The **transcript is the SDK session JSONL**
(`~/.claude/projects/<sessionId>/`, the authoritative copy) **backed up live to R2 blobs
and restored on wake** — same R2-as-runtime-delta pattern as ADR-0001's code overlay /
canvas-state. Two consumers: the Inbox UI renders history from the R2 JSONL while runners
sleep; **resume** restores R2 → runner FS → `query({ resume: sessionId })`.

**Promote protocol** (checkpoint-and-resume, async): the agent has an `ask_human` tool.
Calling it sets the Conversation `waiting-on: human` + unread + notifies, then the agent
commits its branch and **ends its turn** (its runner may sleep). My reply in the Inbox
**resumes the Session** (SDK resume via `sessionId` + my message) on its runner →
`waiting-on: agent` (waking the sandbox if needed) — mirrors the canvas chat's existing
resume-by-`sessionId` pattern. A session enters the Inbox only when it first promotes, so
in-progress agent work doesn't clutter it. Agent done without me → it closes the Conversation.

**Runners** (where sessions execute — the Inbox is agnostic, it only coordinates):
- **Product runtime**: the workspace container (canvas/notebook chats + inbox chats I
  start about my content). Sleeps aggressively (5m) to bound cost.
- **Dev-agent runner**: a **separate sandbox instance of the same image**, with its own
  sleep schedule, for continuous dev workflows. On wake it clones/worktrees
  `Zabaca/cedarpad`, does its work, and **pushes a branch → PR** (durable artifact; a
  non-git baked `/app` edit would evaporate). Own lifecycle so it never pins or gets
  reaped by the product container's sleep timer. **Worktree per concurrent workflow**
  (ADR-0003). Analysis/candidates live as the Inbox Conversation; code changes land as
  a PR. First workflow: scheduled `/improve-codebase-architecture` → promotes a
  Conversation (`waiting-on: human`) with its candidates, grills through that thread.
