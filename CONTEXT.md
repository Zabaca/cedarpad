# Workspace platform — domain model (normative)

> **Status: target model, being designed** (grill session started 2026-07-07). Not
> yet built. This is the workspace-level frame that sits *above* the individual
> apps. It supersedes the single-container / single-canvas framing in
> [canvas/CONTEXT.md](./packages/canvas/CONTEXT.md) + ADR-0001 once implemented.
> Per-app internals stay in each app's own `CONTEXT.md`.

## Domains (ADR-0014)

**`cedarpad.com`** = the marketing site (`packages/www`, waitlist; signup is
invitation-only). **`app.cedarpad.com`** = the product (the canvas app worker; graduated
from `poc.cedarpad.com`, which 301s). **`app.cedarpad.com/admin`** = the operator surface
(Better Auth admin plugin + waitlist + read-only workspace/canvas/chat inventory, no
transcript viewing). There is no `admin.` subdomain. Admin UI says "chats", never
"sessions".

## Runtime & frames

**Workspace**: an isolated runtime **and project/working context** — one Cloudflare
Container, its own filesystem, its own R2 prefix (`workspaces/<ws>/…`, already keyed this
way in ADR-0001), its own sleep timer. A workspace is **NOT tied to one repo**; James may
have **many** workspaces (a project/desk), switched in the Shell; each gets its own
per-workspace sandbox ID + R2 prefix. Within a workspace it's still one container hosting N
canvases + one shared component library (the "one container, N canvases" model applies *per
workspace*). A Workspace **is** the isolated
deployment + org/tenant + membership unit (see Tenancy). _Avoid_: "sandbox", "instance".

## Tenancy — a Workspace IS a deployment (control plane)

**The Workspace is the isolation + membership unit.** A Workspace is, all in one:
- a **deployment** — its own isolated stack (container + D1 DB + R2), provisioned/routed by
  the **control plane** (the shared edge layer: auth, provisioning, routing);
- an **org/tenant** — it **is** the Better Auth **organization** (the org plugin's members +
  invitations); you **invite people directly to a Workspace**;
- the **RCE trust boundary** — its container runs the unsandboxed agent, shared among *that
  workspace's* members (all trusted invitees); different workspaces = different members =
  different isolated deployments.

There is **no separate "Team" layer** — "your team" is a Workspace's member list. This **collapses
the #57 split**: the Better Auth org-"workspace" (singular) and the platform "workspace" are the
**same concept** now — a Workspace is the org *and* the deployment.

**One deployment per Workspace** (chosen isolation model — [ADR-0008]). Isolation is **physical**,
so we **never build RCE-agent sandboxing** — the deployment is the boundary. Rejected: a shared
multi-tenant plane (`tenant_id` scoping + RBAC), which would force sandboxing the RCE agent against
untrusted members — the biggest, most safety-critical build, catastrophic if wrong.

**Data is per-workspace (its own database) in the target.** Because a Workspace = a deployment, its
data lives in its **own database**, so cross-workspace `workspace_id` scoping (#57) largely
**dissolves**: the DB *is* the workspace. The store is **D1** ([ADR-0018](./docs/adr/0018-platform-data-layer-on-d1.md)),
one static binding per Workspace deployment — that cutover landed (#267); what's still ahead is the
**target** below (a database per Workspace, not yet one shared D1).

- **Today (single-deployment approximation)**: one edge Worker + per-workspace *containers* + R2,
  but **one shared D1 DB with `workspace_id` scoping** — what the 20 shipped slices built. It's
  the one-deployment starting point.
- **Target (control plane)**: the control plane promotes each Workspace to a real isolated
  deployment (own D1 DB); `workspace_id` scoping becomes vestigial. **Open public signup** (if
  ever) rides the same control plane — auto-provision an isolated workspace-deployment per signup,
  never a shared plane, so RCE isolation always holds.

_Avoid_: reintroducing a "Team" concept separate from Workspace, or treating the platform Workspace
as a *sub*-thing inside a bigger tenant — the Workspace **is** the tenant/deployment.

**Platform data layer**: the Workspace's relational store — its schema, query modules, and
migrations. It holds the **platform's** rows (`workspaces`, `canvases`,
`workspace_members`, `share_links`; the retired Inbox's `conversations` and
`push_subscriptions` remain until the data cleanup) **and every Better Auth table** (the org plugin's `workspace`/`member`/
`invitation`, plus `user`/`session`/`account`/`apikey`). Each **App** is a *consumer* of it; none
owns it. It lives under `packages/canvas/web-poc/lib/db/` for historical reasons — that path is a
legacy directory name, **not** a statement of ownership. The Notebook's own tables
(`observations`, `problems`, `solutions`) are a small minority of the schema.
_Avoid_: calling this "the web-poc database" or "the Notebook's DB" — the name misleads. Disabling
an App does not remove the platform's dependency on this layer.
**Only the edge reaches it.** Since [ADR-0018](./docs/adr/0018-platform-data-layer-on-d1.md) the
workspace **container holds no database client at all**: the reads and writes it needs go to the
edge over the **platform RPC** (`packages/canvas/shared/platform-rpc.ts`) — named Record verbs,
deliberately a behavioural surface and not a SQL tunnel. The container is handed no connection
string and no credential, so "which side may touch the store" is a structural fact, not a
convention.

**Shell**: the **persistent edge app frame** — the only chrome, an edge-served SPA (the
Worker's static ASSETS) that owns the rail, the workspace switcher, and stage selection;
NOT inside the container. It mounts its stages (Canvas, Components, Notebook, Settings) **inline**
(`?stage=…`), never separate page loads. Always instant; wakes the workspace runtime only
when the canvas stage mounts the Render Pad iframe (`/w/:ws/canvas/:id/pad`) — browsing the
rail never does. **Owns login and is the single gate**: the edge Shell
Worker runs **Better Auth** (against D1) for the Shell, the container proxy, and
Notebook's `/v1/*` — one auth system. Because the edge serves the login/Shell and only
proxies to the container *after* auth, the old pre-auth source-disclosure hole closes
structurally, so **`cs_gate` is removed** (Cloudflare Access becomes optional
defense-in-depth, not a dependency). This word was formerly the name of the canvas
frontend frame — that frame is now the **Render Pad** (below), which frees it.
_Avoid_: calling the Render Pad "shell".

**Render Pad**: the container-served vite surface that renders **one** Canvas (the tldraw
canvas + chat + component loader), addressed at `/w/:ws/canvas/:id/pad` and mounted by the
Shell's canvas stage in a **same-origin iframe** — the only thing that wakes the container.
It was formerly the canvas "frontend frame". Platform containment is **Workspace → Canvases →
Canvas → Render Pad** (the tldraw *pages* layer was removed; see
[ADR-0007](./docs/adr/0007-workspace-platform-topology.md)).

**App**: a launchable surface in the Shell's top nav. Two (the **Inbox** was retired
2026-10-09):
1. **Canvas** — index of all canvases (see below).
2. **Notebook** — Observations + Problems (PM), knowledge graph. From PR #40.

Each app has its own document model, in its own `CONTEXT.md`.

**Scoping across workspaces** (given James has many): **Canvas** and **Notebook** data are
**per-workspace** — a workspace's canvases and its Observations/Problems belong to that
workspace (D1 rows carry `workspace_id`). This `workspace_id` is the **platform**
workspace (the `workspaces` registry / the `cs_workspace` cookie the Shell sets; agents pass
`x-workspace-id`), **not** the Better Auth organization. Notebook records are **isolated per
platform workspace** — workspace A's list/search never returns B's rows (#57); the original
cross-project solution-reuse in the graph is intentionally dropped (a possible future
opt-in). Absent a selection, requests fall back to the legacy `default` workspace, where
pre-#57 rows are backfilled.

**Repos and GitHub auth** — _retired 2026-10-09_. A workspace no longer connects GitHub or
checks repos out: the canvas never changes code, so nothing in it needs a repository. The
`workspace_repos` table and the GitHub App secrets remain until the data cleanup.

## Canvas as a shared surface (not owned by the Canvas app)

**Canvas**: a workspace-owned drawing surface — its own component dir (isolated by path,
served by the workspace's single vite), rendered by its **Render Pad**. It is NOT property of
the Canvas app. It carries an optional **owner** edge:

- `none` — standalone.
- a **Notebook** item (Observation/Problem).

Rules:
- The **Canvas app** is the *index* over ALL canvases regardless of owner; each shows
  an origin badge ("from Problem #12"). A canvas can never be lost.
- Notebook creating a canvas only sets the owner pointer; the canvas still lives
  in the one registry and the one runtime.
- **Owner-delete orphans, never cascades.** Deleting the owning Problem drops
  the pointer; the canvas survives as standalone.

Mirrors the canvas glossary's own shape: a `chat` is a shape *on* a canvas; here a
canvas is a surface *on* a notebook item — an attachment edge, not a copy.

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

(Canvas-internal model — shapes, components, core/extension split — stays in
[canvas/CONTEXT.md](./packages/canvas/CONTEXT.md).)

## Apps — stubs (filled as we design)

**Notebook**: PM ("Problem/Solution intelligence") app. **Edge + D1, not a container
tenant** — it needs no vite compiler and no agent runtime for its core loop, so its Hono
API runs on the Worker against the platform D1 and its SPA is a static build served under
the Shell. Carries over PR #40's crux: the zod-openapi **contract**, Drizzle **schema**,
and **Voyage embeddings / cosine-similarity** pipeline. Drops PR #40's in-container mount
+ in-app `Gate` (the edge Shell owns login). Domain rollout: **Observation** (capture →
embed → similarity) is the beachhead; **Problem** then **Solution** + graph-synthesis
follow. (Full domain model: [packages/canvas/docs/notebook/CONTEXT.md](./packages/canvas/docs/notebook/CONTEXT.md),
to be re-homed.)

**Inbox** — _retired 2026-10-09_ (ADRs 0009, 0012 and 0023 superseded). There are no
Conversations, no `end_turn`, no assignment, no web push and no events hub: a chat is a
`chat` card on its canvas, and a **Session** is that card's Claude Agent SDK conversation
(`sessionId` + transcript). The `conversations` and `push_subscriptions` tables remain until
the data cleanup.

- **Docked chat** (canvas stage): a chat card can be **docked** into a chat pane beside
  the pad — a *mirror*, never a move: the card stays on the canvas and both are live
  views of the same Session. One slot per canvas (docking another replaces it); undock
  just empties the slot; deleting the docked chat's card closes the session and undocks
  (the card is the chat's presence on the canvas — the pane is only a projection of it).
  Which chat is docked is per-device UI memory, not domain state — no schema edge. Dock is
  the ONLY gesture that crosses the pad→Shell postMessage boundary
  (`shared/dock-messages.ts`) — everything else the two surfaces share converges at the
  bridge.

**A chat interface is a live bridge view** (normative): every interactive chat surface —
a canvas `chat` shape, its docked mirror, any future one — connects to **the bridge that
owns the session**, because the bridge hosts the full Claude Agent SDK session *with its
environment*. A chat rendered from anywhere else (e.g. an R2 transcript) is a **photograph
of a different environment**, not the session.

**Storage**: the **transcript is the SDK session JSONL** (`~/.claude/projects/<sessionId>/`,
the authoritative copy) **backed up to R2, one object per session, and restored on resume**.
R2's **only** consumer is **resume-restore** (R2 → runner FS → `query({ resume: sessionId })`);
it is the durability substrate, **not** a read path for display.

**Runners** (where sessions execute). **Every runner runs the interactive bridge** (the SDK
chat multiplexer), so every Session is a *chat* — a reply always **resumes the Session as a
chat turn on its owning runner's bridge**.
- **Product runtime**: the workspace container (canvas chats). Sleeps aggressively (5m) to
  bound cost.
- **Dev-agent** — _retired 2026-10-09_ (ADR-0010/0011 superseded). The canvas never changes
  code: there is no git-token turn, no worktree, no `open_pr`, no Jobs and no cron.

## Data — the workspace warehouse — _retired 2026-10-09_

ADR-0017 is superseded. There is no Warehouse, Mart, Connector or Materialize Job: a
component's live data is a named Notebook query (`shared/data-source.ts`), and a component
that still names a mart renders its static data. The `Warehouse` container class stays bound
in `wrangler.jsonc` only until the Cloudflare container migration deletes it.
