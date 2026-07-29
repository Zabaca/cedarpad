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
workspace*). A workspace **attaches 0..N Repos** (see below). A Workspace **is** the isolated
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
migrations. It holds the **platform's** rows (`workspaces`, `canvases`, `conversations`,
`workspace_members`/`_connectors`/`_repos`, `agent_jobs`/`_runs`, `share_links`,
`push_subscriptions`) **and every Better Auth table** (the org plugin's `workspace`/`member`/
`invitation`, plus `user`/`session`/`account`/`apikey`). Each **App** is a *consumer* of it; none
owns it. It lives under `packages/canvas/web-poc/lib/db/` for historical reasons — that path is a
legacy directory name, **not** a statement of ownership. The Notebook's own tables
(`observations`, `problems`, `solutions`) are a small minority of the schema.
_Avoid_: calling this "the web-poc database" or "the Notebook's DB" — the name misleads. Disabling
an App does not remove the platform's dependency on this layer.
**Only the edge reaches it.** Since [ADR-0018](./docs/adr/0018-platform-data-layer-on-d1.md) the
workspace **container holds no database client at all**: the reads it needs are pushed down through
the edge proxy as forwarded rows, and the writes that originate inside it go back to the edge over
the **platform RPC** (`packages/canvas/shared/platform-rpc.ts`) — four named chat-lifecycle verbs,
deliberately a behavioural surface and not a SQL tunnel. The container is handed no connection
string and no credential, so "which side may touch the store" is a structural fact, not a
convention.

**Shell**: the **persistent edge app frame** — the only chrome, an edge-served SPA (the
Worker's static ASSETS) that owns the rail, the workspace switcher, and stage selection;
NOT inside the container. It mounts Canvas, Notebook, and Inbox as **inline stages**
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

**App**: a launchable surface in the Shell's top nav. Three:
1. **Canvas** — index of all canvases (see below).
2. **Notebook** — Observations + Problems (PM), knowledge graph. From PR #40.
3. **Inbox** — Human-in-the-loop: Claude sessions that need my attention.

Each app has its own document model, in its own `CONTEXT.md`.

**Scoping across workspaces** (given James has many): **Canvas** and **Notebook** data are
**per-workspace** — a workspace's canvases and its Observations/Problems belong to that
workspace (D1 rows carry `workspace_id`). This `workspace_id` is the **platform**
workspace (the `workspaces` registry / the `cs_workspace` cookie the Shell sets; agents pass
`x-workspace-id`), **not** the Better Auth organization. Notebook records are **isolated per
platform workspace** — workspace A's list/search never returns B's rows (#57); the original
cross-project solution-reuse in the graph is intentionally dropped (a possible future
opt-in). Absent a selection, requests fall back to the legacy `default` workspace, where
pre-#57 rows are backfilled. The **Inbox is user-scoped** — one attention
inbox for James, aggregating Conversations across all his workspaces, each Conversation
tagged with its `workspace_id` (filterable by workspace). The **dev-agent workflow operates
on a workspace's attached Repos** (see **Repo**): its scheduled `/improve-codebase-architecture`
runs against a repo the workspace attaches and promotes into the one user Inbox. [per-repo
run granularity — being resolved]

**Repo**: a first-class **GitHub repository attached to a Workspace** (0..N per workspace — a
canvas-only workspace has zero; a dev project attaches several, e.g. app + infra + docs).
Repos are the codebases a workspace's code-aware work (the dev-agent, and future code
surfaces) operates on. There is a global set of repos granted to the platform (via GitHub
auth); each workspace **attaches a subset**, and attachment is **many-to-many** — the same
repo may be attached to several workspaces (it lives on GitHub, cloned transiently, so two
workspaces = two independent clones/PRs). _Avoid_: conflating "workspace" with "repo" — a
workspace is the project/runtime; repos are resources it attaches.

**GitHub auth** (per Workspace): a **GitHub App** installed on the Workspace's GitHub org/account
is the connection — the install matches the Workspace (= org) boundary. Granted repos = the
Workspace's attachable pool; the workspace attaches a subset. The runtime mints **short-lived, per-repo installation tokens** (from
the App private key) for clone/push/PR; commits/PRs are the bot's identity, not tied to any one
member (survives member changes). **"Connect GitHub"** lives in the **Shell** (the owner's
session). This **supersedes `DEV_AGENT_GITHUB_TOKEN`** — the single-repo PAT #64 stubbed in
(`server/repo-worktree.ts`, `GITHUB_TOKEN_ENV`); that becomes the App-token path. Rejected: an
OAuth user token (acts as one person, breaks on member changes, fights the team model).

## Canvas as a shared surface (not owned by the Canvas app)

**Canvas**: a workspace-owned drawing surface — its own component dir (isolated by path,
served by the workspace's single vite), rendered by its **Render Pad**. It is NOT property of
the Canvas app. It carries an optional **owner** edge:

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

**Inbox** (Human-in-the-loop): Intercom-style inbox of Claude sessions.

- **Session**: the atom — one Claude Agent SDK conversation (`sessionId` + transcript).
- A Session has a **home**: a **Canvas chat** (a `chat` shape, canvas app) OR an **Inbox
  Conversation** (inbox app). "Conversation" is deliberately Intercom's word, to avoid the
  canvas glossary's `session = chat` collision.
- **Conversation** = Session + inbox state (open/closed, read/unread, needs-attention,
  last-activity). May own a Canvas (the owner edge above). Carries a **kind**
  (`chat | dev-agent`) — the session TYPE. Background-agent sessions are a kind, never a
  fake workspace: they file under the workspace they run in.
- **Canvas edge** (`canvas_id`, nullable): a Conversation links to **at most one canvas** —
  the canvas its chat card lives on. Direction matters: this is chat → canvas (one canvas
  hosts many chat cards, each pointing back at it), the *reverse* of the canvas's own
  owner pointer (canvas → owning session, provenance). Canvas-born chats get the edge at
  birth; a canvas-less Conversation can **attach** — attach writes the edge AND places a
  live `chat` card shape on the canvas, so the pairing is visible from both sides.
  Create-and-attach makes a new canvas (named from the chat summary) in the
  Conversation's own workspace; attach is **same-workspace only**. No detach (v1).
  In the Inbox thread, the linked canvas renders as a **third pane** — the live Render
  Pad iframe, the same live-synced surface as the canvas stage, never a snapshot; with
  no edge, the pane offers create/attach.
- **Docked chat** (canvas stage): a chat card can be **docked** into a chat pane beside
  the pad — a *mirror*, never a move: the card stays on the canvas and both are live
  views of the same Session. One slot per canvas (docking another replaces it); undock
  just empties the slot; deleting the docked chat's card closes the session and undocks
  (the card is the chat's presence on the canvas — the pane is only a projection of it).
  Which chat is docked is per-device UI memory, not domain state — no schema edge.
- **Focus a chat card** (Inbox thread): the inverse direction of the same in-page channel —
  the open chat's header offers **⌖ On canvas**, which asks the linked pad to center its
  camera on the card fronting *this* chat (select + zoom-to-bounds, the move the canvas side
  panel's instance list already makes). Camera and selection only — nothing on the canvas is
  mutated, so it is pure view state, never domain state. Offered only when the Conversation
  has a linked canvas AND the third pane is showing; a canvas holding no card for the chat
  (the card was deleted) simply does not move. Dock and focus are the ONLY two gestures that
  cross the pad↔Shell postMessage boundary (`shared/dock-messages.ts`) — everything else the
  two surfaces share converges at the bridge.
- The Inbox is a **unified session index**: EVERY Session gets a Conversation row (created on
  its first turn, idempotent by `sessionId`), so the one surface lists all sessions — canvas
  chats and background-agent runs alike. `end_turn` never *creates* the row; it just sets its
  ending state (needs_human **promotes**, done records completion). Noise is handled by the
  default filter, not by withholding rows.
- **State model** (two axes):
  - `status`: `open | closed` — closed = archived.
  - `waiting-on`: `human | agent | none` — `human` = needs my attention; a fresh session lands
    in `none` (exists, nothing pending).
  - `unread`: new agent activity since I last looked.
  - **Views** (the list filter), each sorted by last-activity with `waiting-on:human` pinned:
    - **Open** (default) = `status:open` — every open session, attention pinned to the top.
    - **All sessions** = the whole index, open and closed.
    - **Closed** = the archive.
  - Agent can promote (open + waiting-on=human + notify), post activity (unread), and self-close.
    I can read, reply (waiting-on→agent), close, reopen.
- Populated by sessions I start there and by **background agents that promote their
  session when they need my attention** (first such agent: an always-running
  `/improve-codebase-architecture`).

**A chat interface is a live bridge view** (normative): every interactive chat surface —
a canvas `chat` shape, an opened Inbox Conversation, any future one — connects to **the
bridge that owns the session**, because the bridge hosts the full Claude Agent SDK session
*with its environment* (the runner's filesystem, authored components, cwd, tools). A chat
rendered from anywhere else (e.g. an R2 transcript at the edge) is a **photograph of a
different environment**, not the session. Consequences: (1) opening a Conversation
**connects to its runner's bridge — waking it** (cold-boot latency is the honest cost of
"I'm opening this session," same as opening a canvas); history and live stream come from
that one source, never half-from-R2. (2) The inbox **list** is *not* a chat interface — it
is triage metadata (D1), so it never wakes a runner. (3) One shared chat component backs
every surface; they differ only in *which bridge* they address, never in data source.

**Storage**: **D1** holds Conversation metadata (status, waiting-on, unread,
last-activity, owner edge, `sessionId`, summary, user) + a denormalized last-message
preview so the inbox **list** is fast. The **transcript is the SDK session JSONL**
(`~/.claude/projects/<sessionId>/`, the authoritative copy) **backed up live to R2 blobs
and restored on wake** — same R2-as-runtime-delta pattern as ADR-0001's code overlay /
canvas-state. R2's **only** consumer is **resume-restore** (R2 → runner FS →
`query({ resume: sessionId })` on wake); it is the durability substrate, **not** a read
path for display. The inbox **list** renders from D1 metadata while runners sleep; a
**chat interface never renders from R2** (see "A chat interface is a live bridge view").
An open Inbox tab keeps the list live via a **doorbell**: it subscribes to the container's
chat stream and refetches the D1 list when a frame implies a row changed (turn start,
settle, `end_turn`) — the stream carries no list data, it is purely the signal. A
Conversation's **identity is its chat** (`owner_ref` = bridge chatId); `session_id` is just
the current resume pointer, re-pointed each turn (resume mints a new session id per turn).

**Promote protocol** (checkpoint-and-resume, async): **every turn ends by declaring its
ending** through the mandatory `end_turn` tool (ADR-0012; a Stop hook refuses an undeclared
stop). Outcome `needs_human` (with a question) sets the Conversation `waiting-on: human` +
unread + preview = the question + notifies, then the agent stops (its runner may sleep);
outcome `done` (with a summary) records completion (`waiting-on: none`, unread, preview =
the summary). A question must never live only in prose — routing it through `needs_human`
is what makes "Needs me" truthful. My reply in the Inbox **resumes the Session** (SDK
resume via `sessionId` + my message) on its runner → `waiting-on: agent` (waking the
sandbox if needed) — mirrors the canvas chat's existing resume-by-`sessionId` pattern.
**A session enters the Inbox when it starts** (the moment the SDK assigns its id), landing
in `waiting-on: none` — so a running session is visible live in the "All" view without
cluttering "Needs me". Closing (archiving) is a **human verb** in the Inbox UI; the agent
has no close.

**Notify** (the "notifies" above, #87) is **web push**: the human opts a *device* in from
Settings → Notifications, which registers `/sw.js` and stores that device's push endpoint
(`push_subscriptions`, edge-only). On `needs_human` the bridge signs a VAPID push to every
one of the owner's devices, deep-linking to the Inbox item. It is a **doorbell, not the
signal** — the Inbox row is the durable record, so every delivery failure is swallowed, and
an endpoint the push service reports as gone is pruned. Unconfigured VAPID ⇒ push is simply
off. One channel only; email is deliberately not wired.

**Runners** (where sessions execute — the Inbox is agnostic, it only coordinates). **Every
runner runs the interactive bridge** (the SDK chat multiplexer), so every Session is a
*chat* regardless of runner — a reply always **resumes the Session as a chat turn on its
owning runner's bridge**, streaming back like a canvas chat. There is **no** separate
"approval" interaction: a dev-agent Conversation is a chat too, and the **PR is a tool
action the agent takes mid-conversation**, not a hardcoded consequence of the reply.
- **Product runtime**: the workspace container (canvas/notebook chats + inbox chats I
  start about my content). Sleeps aggressively (5m) to bound cost.
- **Dev-agent**: a **role the warm workspace container plays**, not a separate container
  (ADR-0010) — and a **session KIND, not a workspace**: the Conversation carries
  `kind: 'dev-agent'` and lives in the workspace it runs in (`default`), so `workspace_id`
  means one thing everywhere. (The former `workspaceId: 'dev-agent'` logical tag overloaded
  the workspace field as a type; retired, rows backfilled.) A **dev-agent turn** is any
  bridge chat turn armed with the **edge-minted git-token header** (the App private key
  never leaves the edge); that one signal drives everything dev-agent about it: the
  `'dev-agent'` kind, the **prepared `Zabaca/cedarpad` worktree** it runs in (hub clone +
  worktree off `origin/main`, per-chat branch, reused across turns — never the live app
  tree), and the **`open_pr` tool committing that tree → PR** (durable artifact; a non-git
  baked `/app` edit would evaporate). **Worktree per conversation** (ADR-0003). A
  **dev-agent run** (the Jobs "Run now" / daily cron) is just such a turn kicked headlessly
  on the warm bridge — there is no separate batch execution path — single-flighted with
  join semantics (a kick during a run returns the running run's conversation). Its session
  appears in the Inbox at start like any session, streams live when opened, and can be
  interrupted like any chat. First workflow: `/improve-codebase-architecture`'s Explore →
  the agent itself drops declined candidates (`docs/adr/declined/`) and ends its turn with
  `end_turn needs_human` listing survivors (`waiting-on: human`) — or `done` with none; I
  **grill it through that thread** (a real chat), and it opens the PR when we align.

## Data — the workspace warehouse (ADR-0017)

> **Status: being designed** (grill session 2026-07-26). A workspace can own a pipeline;
> this is a **greenfield capability**, deliberately *not* a 1:1 port of `ceo`'s 93 dbt
> models. Decisions and the measurements behind them: ADR-0017.

**Warehouse**: a workspace's analytical store — parquet files under its own R2 prefix
(`workspaces/<ws>/warehouse/…`). It is **storage, not a server**: DuckDB is a *stateless
engine* that queries those files from the container, never a durable file the container
holds (container disk caps at 20 GB; `ceo`'s warehouse is 22.3 GiB). _Avoid_: "the DuckDB",
"the database" — D1 is the metadata store and is not part of the warehouse.

**Connector**: a declared source that lands raw data in the warehouse. Slice 1 needs none:
the workspace's own **Claude session JSONL is already in the same bucket**
(`workspaces/<ws>/sessions.tar`, persisted so `resume` survives a recycle), so the first
source is a *read*, not an extraction — and third-party extraction secrets stay
deferred. _Avoid_: "source" alone (ambiguous with a dbt `source`), "integration".

**Mart**: the published unit of meaning — **exactly one parquet artifact**, with a
**declared column schema and freshness** (never inferred; a mart without its schema is not
a mart). Two readers, no copies: DuckDB in the container, and a pure-JS parquet reader in
the edge Worker for cold renders. _Avoid_: "report", "dataset", "table".

**Materialize Job**: a `.claude/jobs/<name>.md` (ADR-0015) that runs the pipeline one-shot
in the container and rewrites mart artifacts. Merge arms it; delete disarms it. There is no
scheduler daemon — the edge cron is the evaluator. _Avoid_: "the pipeline run", "the DAG".

### Relationships

- A **Workspace** owns exactly one **Warehouse** (its R2 prefix); a **Warehouse** holds 0..N **Marts**
- A **Materialize Job** rewrites 1..N **Marts**; a **Mart** is rewritten by exactly one Job
- A **Component** references a **Mart** *by name* — `dataSource: { kind: 'mart', name }`, never a URL (#219)
- A **Guest** (canvas ADR-0015 share link) reads only the **Marts the shared canvas references**, resolved from its component instances — not the workspace's mart list

### Flagged ambiguities

- **"mart" vs "data file"** — both feed components, and conflating them forks definitions.
  A **Mart** is warehouse-owned, singular, schema-declared, and read in place. A **data
  file** (`write_data`) is canvas-local ad-hoc data *copied* into a canvas dir. Marts are
  never served via `write_data`: copying a mart per-canvas yields N artifacts with N
  freshness stamps and no way to tell they diverged.
- **"session"** — the pipeline's first source is the Inbox's **Session** (a Claude
  conversation), already glossed above. A session-derived mart covers only turns that ran
  **in the container** (canvas chats + dev-agent runs); local terminal sessions are not in
  `sessions.tar`, so "cost per shipped PR" is a container-side figure.
