# agent-canvas — domain model (normative)

A throwaway product POC: a **tldraw canvas with a built-in chat agent**. You draw
by hand; you also chat with an agent that draws on the same canvas and reads what
is there. The agent is driven by the **Claude Agent SDK** with a set of custom
canvas tools. It runs **locally** today (the agent needs an API/subscription
credential that can't live in the browser, and the component path needs the vite
dev server as its compiler), so this is not a Vercel deploy. A Cloudflare-container
deploy that preserves the dev stack is **designed** in [ADR 0001](./docs/decisions/0001-cloudflare-container-deploy.md)
(not yet built).

## Workspace, canvas, chat — the containment hierarchy

**Workspace**: an isolated environment — one filesystem (the `src/canvas-components/`
library + the app code) and one bridge process. In the deploy it maps 1:1 to a
**container**; locally it is the single dev checkout. _Avoid_: "sandbox", "instance".

**Owner / member**: the two workspace roles (Better Auth `member.role`). A **member**
gets full workspace *use* (chat, agent, canvases, Inbox, notebook); the **owner** keeps
workspace *administration* (invite/remove members, rename/delete). Deliberately no
finer grain: the container is one shared trusted runtime — anyone who can chat can do
anything the agent can, so the admission decision is binary. Access checks are
owner-OR-member (`getWorkspace`/`listWorkspaces`); the legacy `default` workspace has a
real owned row, no bypass. Only the owner invites — admission is a capability grant.

**Invitation**: an email-bound, single-use, expiring copyable link (Better Auth
`invitation` row; no outbound email infra). Accepting is the ONLY account-creation
door: `AUTH_DISABLE_SIGNUP` stays on forever, and the accept endpoint creates the
account server-side (per-request auth instance) for exactly the invited address.
_Avoid_: any public signup path, or an invite link that works for a different email.

**Canvas**: one drawing surface (one `CanvasStore`: its own shapes and chats)
inside a workspace. Multiple canvases in a workspace share the same component
library. Today the bridge hosts exactly **one** canvas; multi-canvas-per-workspace
is a fast-follow (ADR 0001). _Avoid_: calling a canvas a "session".

**Chat / session**: one conversation — a `chat` shape, its id is the chat id, with
a Claude Agent SDK resume `sessionId`. **"session" means a chat, never a canvas.**

**Transcript**: the rendered history of a chat (messages, tool-call chips). Its
authoritative copy is the SDK's own session JSONL (`~/.claude/projects/<sessionId>`),
*not* a store of ours; the UI transcript is a projection of it (ADR 0004). _Avoid_:
treating the transcript as canvas state, or as a thing we persist separately.

**ChatMeta**: the server-owned per-chat record `{ sessionId, model, effort, forkNext }`,
the durable home for a chat's resume pointer and config, and the only place the
`chatId → sessionId` link lives (the JSONL carries no chat id). Replaces the old
per-browser `localStorage`. _Avoid_: putting any of this on the `chat` shape.

**Conversation / Inbox**: a Conversation is the edge-side index row of a session (chat or
dev-agent run); the Inbox is the **workspace-shared** list of them — every member sees the
same index, it is not a per-user mailbox. On the row, **creator** (`user_id`, immutable
attribution: who started it) is distinct from **assignee** (`assigned_to`, nullable =
unassigned, mutable: who has taken ownership of it); filtering by "mine" means assignee,
never creator. Visibility and action are membership-gated, not creator-gated: any member
sees every conversation and may reply. Assignment is **advisory** — a coordination
signal/filter, never a lock; any member may assign anyone (or unassign), and replying to
an *unassigned* conversation auto-assigns the replier. At birth: a conversation started
by a human (UI chat, MCP `send_message` — the token's user) is auto-assigned to that
initiator; unattended starts (cron dev-agent runs, scheduled jobs) begin unassigned —
queue work awaiting a claim. UI: the Open/All/Closed view switch is unchanged
(`waiting_on: human` stays a pinned indicator inside Open, not a view); a new
**"Assigned to" filter** beside it selects Everyone (default) / Unassigned / a specific
member, composing with any view. Surface: `POST /api/inbox/:id/assign` `{ userId | null }`
(membership-gated; target must be a member), `?assigned=` on the list, `assignedTo` on
`InboxItem`; MCP gets full parity (`assign_conversation`, the `assigned` filter on
`list_inbox`) — and since a token acts as its user, `send_message` into an unassigned
conversation claims it for that user, deliberately. _Avoid_: scoping Inbox reads by
`user_id`, repurposing `user_id` as the assignee, or making assignment exclusive
(assignee-only reply). _(Decided 2026-07-15.)_

**Visibility (canvas + chat)** _(ADR-0016, decided + implemented 2026-07-17)_:
a canvas is **workspace-visible** (default; today's behavior) or **private** —
private means only its **creator** (`created_by`, a new registry column) can see or
open it; everyone else, list and routes alike, gets the same 404 as a nonexistent
canvas. Standalone chats get the same opt-in flag: shared by default, the chat's
creator may flip it. Effective rule: a conversation is hidden from user U iff
(its canvas is private AND U ≠ the canvas creator) OR (the chat is flagged private
AND U ≠ the chat creator) — **canvas privacy dominates**: re-privatizing a canvas
hides ALL its attached chats, even from their own creators, until re-published.
Flips are creator-only, both directions; the workspace owner additionally gets
**manage-not-read**: sees that a private canvas exists (name, creator) and may
force-publish or delete it, but cannot open it while private. Legacy canvases with
no recorded creator — and the registry-row-less `default` canvas — are permanently
workspace-visible. Share links still work on a private canvas (an explicit act by
its creator); MCP enforces the same rules via the token's user. _Avoid_: an
"admin" role (there is only owner/member), copying visibility onto conversation
rows (derive it at read time via the canvas edge), or treating private as an ACL
(it is a binary creator-only flag, not per-member sharing).

Containment: **workspace → canvas → shapes**, with **chat** shapes living on the
canvas like any other shape; a chat's `ChatMeta` and transcript live *beside* the canvas,
server-owned, not inside canvas state. (The tldraw **pages** layer was removed — see
[ADR 0007](../../docs/adr/0007-workspace-platform-topology.md).)

## Core vs extension — the modifiability boundary

The codebase splits into two zones by who owns them (see [ADR 0002](./docs/decisions/0002-core-extension-split.md)):

**Core**: the code that must stay correct for the canvas to work — image-only, the agent must not modify it. Two parts:
- **Render Pad**: the container-served frontend — `App.tsx`, `sync.ts`, `ComponentShape`, the tldraw canvas + chat. The navigation chrome (rail, canvas selector) now lives in the edge **Shell SPA** (`shell/`, PRD #103), which iframes this pad. _Avoid_: calling a canvas-component part of the "pad".
- **Bridge** (a.k.a. **bridge core**): the single stateful backend process — the `CanvasStore`, persistence, the agent runner, the core `/api/*` routes. The authoritative owner of canvas state.

**Extension**: what the agent authors — hot-reloaded and persisted to R2:
- **Component** (`src/canvas-components/<Name>.tsx`): an agent-authored React module placed on the canvas. Already in use.
- **Custom handler**: an agent-authored backend handler, served by a separate **extension server** process and reached at `/api/custom/:handler`. Contract: HTTP request in → may call outbound (APIs, DBs, the core's own `/api/canvas`) → HTTP response out; **no direct `CanvasStore` access** (it's a different process — canvas reads/writes go through the core's API). _Decided, not yet built._
- **Workspace skill** (`.claude/skills/<name>/` under the package root): a user- or agent-authored skill dir (SKILL.md + supporting files), persisted per workspace and discovered via the SDK's `project` setting source. Chat turns enable **all discovered** skills — no allowlist. Distinct from a **platform skill** (baked into the image at the container's `~/.claude/skills/`, the `user` source: deploy-versioned, PR-reviewed, unshadowable by workspace content). On a name collision the workspace skill wins for chat turns; dev-agent turns keep a pinned skill list resolved in a cwd with no workspace skills (its worktree). _Decided, not yet built._

A skill is **content-that-asks** — text the model reads. It is never a **capability** (a grant: tools, tokens, scopes, routing). Capabilities stay code-gated; no workspace data may confer one.

**External MCP** (the agent consuming outside tool servers) follows the same line. The **MCP registry** (code, PR-gated, global) is the catalog of approved remote HTTP servers — the trust decision that cedarpad may talk to an endpoint at all. **Enablement** is per-workspace and is an act of owner consent (v1: paste a per-workspace bearer token at connect time; later: an OAuth dance — a registry entry declares its auth kind). **Token custody is edge-side**: per-workspace credentials live in the worker's DB, are attached as a header on the proxied `/send`, and are used for that turn only — the container and R2 never store them (the ADR-0008 dev-agent git-token pattern). A workspace that hasn't connected a server gets no tools, no token, and no connection attempt; an unreachable server degrades that turn's toolset, never fails the turn. Chat flavor only; dev-agent turns get no external MCP servers.

**Repo**: a **workspace asset** — like a Canvas, Component, or Skill, something the owner *adds* to the workspace, whereupon its content is part of the medium. Reading is workspace-wide: the bridge (platform code, never a turn) maintains a read-only checkout of each added repo in the container, refreshed eventually (boot + cadence + explicit refresh), and every chat turn may read it as plain files — no repo credential ever enters a turn. Writing (worktrees, commits, PRs) remains exclusively the dev-agent turn surface. Adding a repo is a capability grant to the whole workspace (every member's chats can read it). Pasting a GitHub URL onto the canvas places a **GithubRepoCard** — a live *view* of the asset (never its owner): it looks up cloned-ness from the workspace repo set, offers the owner-gated Clone (which for a public repo adds it token-less), and turns a member's 403 into a visible clone request. Chat turns are told what is checked out via a per-turn REPOS system-prompt line built from `.repos/` on disk.

**Repository connection**: the credential plumbing *behind* the Repo asset — how a workspace authenticates to GitHub for a given repo. Three sources: the **GitHub App installation** (`installationId`, obtained when the workspace owner installs cedarpad's App on their org via a signed-`state` connect flow; one installation per workspace, covering its granted repos) a **per-repo PAT** (for repos outside the installation's identity — e.g. a client-issued GitHub account; stored encrypted at rest, decrypted only at the moment of use), or **public** (no credential at all — pasted-in public repos; reads clone the public remote, PRs are impossible). Which repos are in scope is the owner's **selection**; selection drives job discovery, platform-job targets, token minting, and the read-only checkout set. **One run = one repo**, chosen at trigger; the conversation binds to it like a `canvasId`. The App identity (app ID + private key) stays platform env; installation, PATs, and selection are workspace config — like other `workspace_id`-scoped data, they travel with the workspace when deployments split (ADR-0008, [ADR-0015](../../docs/adr/0015-repos-are-workspace-config-jobs-are-repo-content.md)).

**Job**: an agent-executable task definition — `.claude/jobs/<name>.md` in a selected repo (frontmatter `name`/`description`/`schedule`, body = the prompt) — the sole registry; there is no platform built-in job (#100). Agents author jobs by opening PRs; **the merge is the arming step** — nothing runs until the job is on the default branch. Discovery is pull-based (the default branch *is* the registry; contents-API fetch, SHA-cached; reconcile, don't register); the platform cron tick is an evaluator (due-ness vs a `lastRunAt` stamp), gated by `DEV_AGENT_ENABLED`. Every run wraps the job body in the code-defined triage law + token custody — a job steers *what*, never *under which rules*. A job runs against its home repo; a run with no job is an error, never a default prompt. _Decided, not yet built_ ([ADR-0015](../../docs/adr/0015-repos-are-workspace-config-jobs-are-repo-content.md)).

**Gated-layer rule**: content that steers a token-holding turn must come from a **gated layer** — platform (deploy-gated) or repo (PR-gated). The workspace layer (agent-writable, ungated) feeds chat turns only. Hence workspace skills exist but workspace jobs/agents deliberately don't.

**Inbound MCP** (outside agents interacting with a workspace) is the only supported programmatic surface — there is deliberately no inbound REST/turn API (a service credential that can execute turns is an RCE credential; MCP's OAuth keeps the boundary at humans delegating to their own agents). The server runs at the edge; a token acts as its user, and every tool is ownership-checked per workspace. Tools split by the same line: **content + read** (`upload_skill`, `read_canvas`, `list_inbox`, `read_conversation`, …) vs **execution** (`send_message`). An MCP-originated chat is an ordinary Conversation — same session index, visible in the Inbox, resumable from the UI; `send_message` is async (returns `conversation_id` immediately; callers poll `read_conversation`) and runs plain chat flavor, never dev-agent — a dev-agent run is triggered only through the explicit `run_dev_agent` tool, which shares the Jobs "Run now" core (`triggerDevAgentRun`): repo must be in the selected set, a named job's prompt is re-read off the repo's default branch, runs single-flight with join. `create_canvas` uses the same registry create as the shell route. Mutations funnel through the bridge (single writer of the workspace tree — `upload_skill` proxies to a bridge endpoint and wakes the container); only pure reads are served edge-side.

_Avoid_: "self-modifying app" (ADR 0001's framing) — there is now a boundary; only the extension zones are mutable+durable, the core is image-only.

This file is the normative glossary for the **domain/behavior** model. Features
should snap onto this model.

The **visual** layer has its own source of truth: [`DESIGN.md`](./DESIGN.md) (the
cedar token system — warm-graphite neutrals + one Cedar Ember accent that means
*live* — typography, elevation, component rules), with [`PRODUCT.md`](./PRODUCT.md)
as the strategic frame and [`.impeccable/design.json`](./.impeccable/design.json) as
the machine-readable sidecar. Token values live in `src/styles.css` `:root`; app
chrome and `src/canvas-components/*` conform to them. CONTEXT.md owns behavior;
DESIGN.md owns the look.

## Architecture: one process, one source of truth

```
 browser (tldraw + chat)            bun bridge (:4511)               Claude Agent SDK
 ───────────────────────            ──────────────────               ────────────────
  human draws ──POST /shapes──▶  ┌────────────────────┐
  SSE /canvas/stream ◀──push───  │  CanvasStore        │ ◀─tool calls─ create/update/
  chat ──POST /chat (SSE)────▶   │  (id→shape, version)│   delete/clear/align/read
                                 └────────────────────┘
                                   the agent's tools mutate the SAME store,
                                   so agent edits stream to the browser live.
```

- The **bridge** (`server/bridge.ts`) is the only stateful component. It owns a
  `CanvasStore` and serves canvas sync + the `/api/chat` agent endpoint.
- The **browser** (`src/`) is a pure client: a full-bleed tldraw editor wired to
  the bridge by `src/sync.ts`. Chat lives **in the canvas** — each session is a
  `chat` shape (`src/ChatShape.tsx`); a floating "New chat" control spawns one.
- Dev runs both with `bun run dev` (bridge :4511, vite :4510; vite proxies
  `/api/*` → bridge).

## The simplified shape model (`src/shapes.ts`)

The agent and the bridge speak a **simplified** model, deliberately smaller than
tldraw's internal records so it stays LLM-legible. tldraw shapes are translated
to/from this model in exactly one place: `src/tldraw-bridge.ts` (browser only).

A `CanvasShape` is one of:

| type        | fields (besides `id`, `color`)        | who authors |
|-------------|---------------------------------------|-------------|
| `rectangle` | `x, y, w, h, text`                    | agent + human |
| `ellipse`   | `x, y, w, h, text`                    | agent + human |
| `text`      | `x, y, text`                          | agent + human |
| `note`      | `x, y, text` (sticky)                 | agent + human |
| `arrow`     | `x1, y1, x2, y2, text`, optional `startShapeId`/`endShapeId` | agent + human |
| `draw`      | `points: [x,y][]` (freehand)          | **human only** |
| `component` | `x, y, w, h, module, data, rev`       | **agent only** |
| `chat`      | `x, y, w, h, title` (a conversation card; id IS the chat id) | **human only** |
| `image`     | `x, y, w, h, src` (data URL), `alt` (a pasted/dropped screenshot/photo) | **human only** |
| `frame`     | `x, y, w, h, name` (a container; children carry `parentId`)  | **human only** |

- Every shape may carry an optional **`parentId`** (a frame's shape id). It is set
  only when the shape is a child of a `frame`; top-level (page-parented) shapes omit
  it. When present, that shape's `x/y` are **parent-relative** (tldraw's native
  representation), so a frame and its children round-trip with no coordinate math —
  the only rule is the frame must be created before its children (`sync.ts`
  `orderByParent`). Re-parenting an existing shape into a frame on another client is
  not yet propagated over sync (the create path on reload is correct; live
  cross-client re-parent is deferred).
- **A canvas has no pages.** A top-level shape carries no tldraw parent (tldraw
  parents it to the canvas itself); only a frame child carries one. Canvases
  persisted before the pages layer was removed still hold a `pages` array and a
  per-shape `pageId`; both are **dropped in `CanvasPersistence.load()`**, the one place
  a stored blob becomes a `CanvasState`, so no R2 migration is needed. A `pageId` that
  survived into the live store would defeat `canon()` change detection for that shape
  on every sync frame — which is why the strip is at the boundary and not left implicit.
- `id` is shared verbatim with the tldraw shape id (`shape:...`). Agent-created
  ids are minted `shape:agent_N`.
- `color` ∈ `black, grey, blue, green, red, orange, yellow, violet` (a subset of
  tldraw's palette; tldraw's `light-*` variants clamp down to these on read).
- Coordinates are tldraw **page coordinates** (origin top-left, +x right, +y down),
  except a frame child's `x/y`, which are relative to its frame (see `parentId`).
- **`chat`, `frame`, and `image` are human-only built-ins the converters must keep in sync**:
  both directions of `tldraw-conventions.ts` (and `normalize.ts`) carry a case for
  every `CanvasShape` variant. A dropped case silently breaks reload sync (it once
  did for `chat`), so `toTldrawPartial` has a `never` exhaustiveness guard.
- **`image` is human-only and lives half out-of-band**: the human pastes/drops a
  screenshot; the pixels live in a tldraw **asset** record, not the shape. The
  converters bridge that: editor→model resolves the asset's data URL into the
  shape's `src` (`tldraw-bridge.ts` via `editor.getAsset`), and model→editor
  recreates the asset from `src` before the shape (`sync.ts` `ensureImageAssets`,
  using a deterministic `imageAssetId(shapeId)`). `src` rides inline in the model
  (and over SSE / in persistence) — fine at POC scale, a few screenshots; revisit
  (a separate asset endpoint) if many/large images make full-state broadcasts heavy.
  `src` is **redacted** from `read_canvas`/`read_connected` (a data URL would flood
  the agent's context); the agent views an image via the **`read_image(id)`** tool,
  which returns it as a real image block. The agent cannot create images.
- **`read_connected` is the agent's "what am I linked to?" view**: a BFS over bound
  arrows (`connectedOp`) returning the connected subgraph (nodes with full state +
  edges), defaulting to the originating chat card. `direction` (out/in/both) and
  `depth` (hops; omit = whole component) scope it.
- **Agent-created shapes auto-attach to their chat**: `createShapesOp`/
  `placeComponentOp` route the originating `chatId` through the single
  `attachBatchToChat` seam, which positions the new batch near that chat and links it
  with a grey bound arrow chat→each new root shape. So the agent's output is a
  connected subgraph it can later recall via `read_connected`.
- **Freehand `draw` is human-only**: the agent can read strokes but the create
  path rejects them (`normalizeShape`).
- **`component` is agent-only**: it is an *instance* of a real React module the
  agent authored under `src/canvas-components/`. The shape references the module by
  name (`module`), passes `data` as props, and carries a `rev` reload token. The
  human can select / move / resize the box but never edits code in it. It round-
  trips like any other shape. See "Custom components" below.
- **Components can be interactive + persistent via `setData`**: besides its `data`
  props, every component instance is rendered with a `setData(patch)` prop
  (`ComponentShape.tsx` `ComponentHost`, bound to the shape's editor + id). Calling
  it merges `patch` into that shape's `data` through `editor.updateShape`, so the
  state syncs to the bridge and survives reload — no separate store. Interactive
  controls must be real elements (`isInteractiveControl`: button/input/textarea/
  select/a/label/[role=button]) so the pointer reaches the component instead of
  dragging the shape. `Kanban.tsx` is the worked example (a ticket board: add /
  move / edit / delete cards, all persisted via `setData`).
- **Components know who is looking (`currentUser`, #211)**: every instance also
  receives `currentUser` (`{id, name?, email?, color, kind: 'user'|'guest'}`) and
  `setDisplayName(name)`. One identity source (`src/identity.ts`): the Better Auth
  session (`/api/auth/get-session`) when logged in — name falls back to the email
  local-part — else a stable per-browser guest (`guest_<uuid>` + derived color in
  `localStorage`), degrading to guest when the endpoint is absent (local dev).
  Guest naming is ask-once: `setDisplayName` persists browser-wide and is a no-op
  for logged-in users. Presence (#212) reuses this identity.
- **Live presence (#212)**: transport is ours, rendering is tldraw's. Each browser
  heartbeats `{userId, name, color, cursor, camera}` to `POST /api/canvas/presence`
  (change-gated ~150ms, 2s keepalive; `src/presence.ts`); the bridge keeps an
  ephemeral per-canvas room (`server/presence.ts`, never persisted, 10s staleness IS
  the disconnect) and broadcasts the merged set over the EXISTING canvas SSE as
  throttled `event: presence` frames. The client maps remote entries (self excluded)
  to `instance_presence` records — invisible to shape sync, which filters on
  typeName — and tldraw's built-in collaborator UI does the rest: labeled cursors,
  the people face-pile (`DefaultSharePanel`/`DefaultPeopleMenu` in `App.tsx`), and
  click-to-follow via `startFollowingUser` (auto-unfollow on local pan/zoom). The
  wire type `PresenceEntry` lives in `src/presence.ts`; `parseHeartbeat` is the
  bridge-side guard of the same contract.

- **Interactive box**: the shared kind behind the two shapes whose content is live,
  interactive DOM (`component`, `chat`) — a resizable rounded card that takes real
  pointer/keyboard/wheel events while still dragging/selecting like any shape. Each
  such shape's ShapeUtil derives from one base; a subclass supplies only its props,
  content, and which events its content owns. _Avoid_ re-inlining the box wiring per
  shape, or calling a plain `component` instance an "interactive box". code:
  `src/InteractiveBoxShapeUtil.tsx`.

## CanvasStore (`src/store.ts`) — the invariants

- `id`-keyed map + a monotonic `version`. Mutations are **upsert-by-id** and
  **delete-by-id** (last-writer-wins per shape; no whole-document clobber).
- `version` advances **only on a real change** (empty upsert / missing-id delete /
  clear-when-empty are no-ops and do **not** bump). `version` is what drives
  client reconciliation, so this is load-bearing.
- `getState()` returns shapes **sorted by id** (deterministic reads + diffing).
- An optional `onChange(state)` fires once per real mutation → the bridge
  broadcasts to SSE subscribers.

## Bridge protocol (`/api`)

| route                     | method | purpose |
|---------------------------|--------|---------|
| `/api/canvas`             | GET    | current `{version, shapes}` |
| `/api/canvas/stream`      | GET    | SSE; primes with state, pushes on every change |
| `/api/canvas/shapes`      | POST   | `{shapes}` upsert (browser → store; accepts `draw` + `image`) |
| `/api/canvas/delete`      | POST   | `{ids}` delete |
| `/api/canvas/clear`       | POST   | clear all shapes |
| `/api/chat/stream`        | GET    | SSE; **one stream for ALL chats**, each frame tagged with `chatId` |
| `/api/chat/:id/send`      | POST   | `{message, sessionId?, images?}` → 202; events **broadcast** (tagged) to subscribers; **425** when no chat stream is subscribed |
| `/api/health`             | GET    | `{ok, shapes}` |

Chat is **multi-session pub/sub over one multiplexed stream**. A chat `:id` is one
conversation; on the canvas each `chat` shape is one session, with the **shape id
as the chat id**. The bridge keeps a **single** client subscriber set
(`chatClients`); `/send` runs one agent turn and broadcasts its `ChatEvent`s —
each frame **tagged with its `chatId`** — to every subscriber, which routes by
chatId. One stream for ALL chats is deliberate: a browser caps ~6 connections per
host (HTTP/1.1) and each `EventSource` holds one open forever, so one-stream-per-
chat-card means a single tab with a few chats + the canvas stream saturates the cap
and starves every POST (`/send`, shape upserts) into "pending". A session's output
is visible regardless of who triggered it (the chat card, another client, or an
on-canvas component posting to `/send`). Session state (transcript, resume token,
SSE subscription) lives in the client-side `src/chat-store.ts` singleton, keyed
by chat id and **independent of any React component** — so a chat card culled by
tldraw when scrolled off-screen keeps streaming; the SSE closes only when the
chat shape is deleted (`App` watches the editor for removed `chat` shapes).
Subscribe BEFORE sending: the client gates send on its stream being open
(`subscribed`) **and** the server enforces the same precondition at the wire —
`/send` with no subscriber returns **425 Too Early** and dispatches nothing
(otherwise the turn's events broadcast into the void; there is no replay).
`sessionId` is the Claude Agent SDK
resume token (echo the last `done`'s `sessionId` back on the next `/send`); it is
distinct from the chat `:id`.

Each frame on that stream is a **`ChatFrame`** (a `ChatEvent` tagged with its
`chatId`). **`ChatEvent`** is discriminated on `kind` ∈ `delta`, `tool_start`,
`tool`, `thinking`, `tool_progress`, `task`, `todo`, `done`. The canonical type, its
kind list, and the `isChatFrame` routing guard live in ONE place (code:
`shared/chat-wire.ts`), imported by the producer (`server/bridge.ts`), the
source-of-truth stream (`server/agent.ts`), and the consumer/router
(`src/chat-store.ts`), so a new kind is added once and read once.
_Avoid_: re-declaring the kinds in any of those three modules.

## Agent tools (`server/agent.ts` → `src/canvas-ops.ts`)

The tools are an in-process MCP server (`createSdkMcpServer`); shape logic lives
in `src/canvas-ops.ts` (pure, unit-tested), component-file logic in
`server/components.ts`. The canvas tools: `read_canvas`, `view_canvas` (PNG),
`create_shapes` (batch), `update_shapes` (merge-by-id), `delete_shapes`, the
component-library tools (`list_components`, `read_component`, `write_component`,
`edit_component`, `write_data`, `place_component`, `set_component_data` — see
below), `clear_canvas`, `align_shapes`. The agent is a **full Claude Code
agent**: it also has the built-in tools (Bash, Read, Web*, Task, ...) plus the
`impeccable` skill (`settingSources: ['user','project']` + `skills` filter),
auto-approved (`bypassPermissions`). Unsandboxed — see the security note below.

**Chat turns drop the generic `Write`/`Edit`/`NotebookEdit` tools**
(`disallowedTools`): a plain Write drops an unregistered file — unserved, never
hot-reloaded, invisible to `list_components` (the QABoard incident) — so
component and data files may only be authored through the registered tools
(`write_component`/`edit_component`/`write_data`, which bump revs and flush the
components sink). Dev-agent turns keep the full preset (worktree edits are their
job). Bash remains, so this steers the model rather than sandboxing it.

The agent's "thinking" and replies to the human are its normal chat text — not a
tool. The human watches shapes appear in real time via the canvas SSE while the
text streams on the chat channel.

**`send_message` (cross-chat)** — a chat turn may post a message into ANOTHER
chat card's thread on its canvas and kick that card's turn (parity with the edge
MCP's `send_message`). Bridge-bound seam (ChatMeta + the turn dispatcher),
fire-and-forget: the reply streams into the target card, the sender polls
`read_canvas`/`read_connected`. Guard rails: no self-send, the target must be a
chat card on the sender's canvas, an in-flight target refuses (one turn per
chat), and the delivered message is prefixed `[from <chatId>]` so the receiving
thread knows who is speaking. Chat flavor only — dev-agent turns never see it.

## Custom components — a real, file-based component library

For anything the fixed primitives express poorly (charts, tables, KPI cards,
dashboards, formatted layouts), the agent builds **real React component files**
in the canvas's own dir (`src/canvas-<id>/components/` — uniform for every canvas,
`default` included) and places *instances* of them on the canvas (ADR-0014).
Components are normal modules: they **compose** (import each other), take **data**
(props), and import real npm deps (e.g. `mermaid`). This is the "B" design (the
"A" in-memory `code`-string + sucrase + `new Function` path was removed).

The round-trip:

1. The agent authors a module with `write_component(name, source)` /
   `edit_component(name, old, new)` (per-line edits), scoped by `server/components.ts`
   to the canvas own dir / shared lib (validated names, no path escape).
2. `place_component({ module, x, y, w?, h?, data? })` creates a `component` shape
   referencing the module + props + a `rev` token. `set_component_data(id, data)`
   updates just the props.
3. The browser's `ComponentShapeUtil` (`src/ComponentShape.tsx`) renders the shape
   via `loadComponent(module, rev)` (`src/component-loader.ts`), which
   **dynamic-imports** the module (own dir → `@shared` → platform base). **vite** is
   the compiler — it transpiles the file on request and resolves all its imports
   (react, other components, mermaid, data files) exactly like any app module.
4. Editing a file bumps `rev` on **every** placed component (`bumpAllComponents`,
   via `nextComponentRev`), so the open canvas re-imports the recompiled modules
   live. Reload-all (not just the edited module) is deliberate: a leaf edit must
   reach the containers that import it; vite refreshes the transitive imports.

- **Shared library (`@shared`, #55)**: besides its own dir, a canvas can `promote_component`
  a module into the workspace `shared/components/` dir (one live source; vite resolves the
  `@shared` alias to it). A placed instance references a module by its **bare name**, and
  `component-loader` resolves **own-dir first, then `@shared`, then the platform base**
  (`componentUrls`, ADR-0014) — so promote
  is a pure file *move* (`server/components.ts` `promoteComponent`), instances stay stable,
  and another canvas placing the same bare name gets the one shared source. Editing a shared
  module fans the rev-bump out to **every canvas that placed it** (`bumpSharedModule` over the
  session registry's `built()`), not just the current store. `adopt_shared_component` copies a
  shared module back into a canvas's own dir (own-dir then shadows shared) so it can diverge.
  Reads (`list_components`/`read_component`) span own dir + `@shared` + base. UI mirror: right-click a
  component shape → Promote / Copy to this canvas (`src/component-library.ts`, `App.tsx`).
- **Platform tier (ADR-0014)**: `src/canvas-components/` is the image-baked seed library —
  visible to every canvas as the last resolution fallback, read-only at runtime (no tool
  writes there; writing a platform name shadows it into the canvas own dir). Persistence
  follows writability: `canvas-components.tar` (all own dirs) + `shared-components.tar`
  persist to R2; the platform dir ships with the image (the legacy `components.tar` is
  still restored at boot for historical content but never flushed again).
- The content renders inside an **error boundary**; a load or render failure shows
  a red card in the box and never crashes the canvas. While a module loads you see
  a "loading…" placeholder.
- **Component status**: a `component` instance's load/render lifecycle (`loading`,
  `ready`, `load_error`, `render_error`), which the host mirrors onto the shape's
  tldraw `meta` so it persists and the agent can observe (via `read_canvas`) whether
  a placed component actually came up. Optional: a shape without it is valid (older
  docs read back none). _Avoid_: confusing it with `rev` (a reload token, not a
  lifecycle) or with the component's own `data` props. code: `ComponentStatus` /
  `meta.status` in `src/ComponentShape.tsx`.
- `component` is registered as a first-class tldraw shape via the augmentation hook
  (`declare module '@tldraw/tlschema'` in `ComponentShape.tsx`), so `ShapeUtil` /
  `resizeBox` / `TLResizeInfo` type-check without casts (hence `@tldraw/tlschema`
  is a direct dep). `data` validates as `T.jsonValue`.
- Seed library (also the agent's reference for conventions): `KpiCard` (leaf, takes
  props), `Dashboard` (composes `KpiCard`), `MermaidDiagram` (real `mermaid` import,
  render-and-inject). Agent-authored files are excluded from `tsc` (vite/esbuild
  compiles them with no type gate, matching runtime).
- **Component palette** (`src/ComponentPalette.tsx`) — pad-chrome panel (❖
  Components fab, members only) over `GET /api/components` + `POST
  /api/components/place`: browse/filter the library, one-click place at the
  viewport center. The human's no-agent placement path.

> **Dependency on the dev server / security.** Because vite is the compiler, this
> path is **dev-server-only** (a static `vite build` has no compiler for files
> written after the build). Agent-written components run with full browser
> capability once compiled in — same trust level as the agent's own shell access, on your
> machine, in an isolated worktree. The agent's file access is scoped to the
> components dir, but the code it writes is not sandboxed. Fine for a local POC;
> revisit before any non-local exposure.

## Sync invariants (`src/sync.ts`) — echo-safety

- **remote → editor:** SSE state is diff-reconciled into the editor inside
  `editor.store.mergeRemoteChanges(...)`, so applying it does **not** re-trigger
  the push listener (which is scoped to `source: 'user'`). Frames older than the
  last applied `version` are ignored — **except** that the SSE `onopen` resets the
  high-water mark to `-1`, so a reconnect (the bridge restarts and resets its
  version counter on every server-code reload) always re-accepts the bridge's
  state as authoritative instead of silently drifting out of sync.
- A local shape is only **deleted** by reconciliation if the server once had it
  and now dropped it (`mirrored` set) — never a brand-new local shape mid-draw.
- **editor → remote:** the user's document changes are translated and POSTed,
  **debounced 80ms** to batch drags.
- **Arrow bindings live in separate `binding` records, not shape props** (tldraw
  v5). An arrow's `startShapeId`/`endShapeId` are reconciled into real bindings
  *after* shapes exist, inside `mergeRemoteChanges` (`reconcileArrowBindings`,
  idempotent). Upward, `fromTldrawShape` reads `getArrowBindings` and zeroes a
  bound terminal's coords (so dragging the target doesn't churn the diff), and the
  store listener also watches `binding` records to re-push the affected arrow when
  a human binds/unbinds. A bound terminal follows its target on move.

## Guest share links (ADR 0015, PRD #220 — live)

- **Share Link** — a member-minted, revocable capability row (`share_links`, Turso) granting
  outsiders access to exactly one canvas, with per-link permissions
  `{collaboration, guestChat}`. No default expiry; lives until revoked.
- **Guest Session** — a real session minted at `/share/<linkId>`, carrying
  `{linkId, canvasId, permissions}`. Flows through the same sole edge gate as members; the
  gate confines it to an explicit per-canvas path allowlist. Distinct from the per-browser
  **guest identity** (#211), which is only the attribution/display-name layer a guest session
  reuses.
- **Guest mode (Shell)** — the same Shell SPA with workspace chrome hidden, hard-locked to
  the link's canvas. Member conversations render view-only; a `guestChat` link lets guests
  start their own canvas-scoped conversation.
- **Component share link** (PRD #221, ADR-0015 amendment) — a Share Link with `shapeId` set:
  the guest surface narrows to that ONE placed component, rendered fullscreen by the pad in
  component-guest mode (no tldraw, chat fully denied). Interactive: `setData` persists and
  syncs. Accepted v1 gap: the API grant reuses the canvas allowlist (canvas-wide reads),
  only the UI narrows. Minted from the ⛶ fullscreen header's Share panel.
- Enforcement layers: `worker/guest-gate.ts` (pure default-deny path allowlist at the edge,
  per-request revocation recheck) + the bridge's `x-guest-canvas` confinement (SSE frame
  filter, member-conversation view-only rule, guest turns are plain chat turns). Member
  surface: the Share panel in the canvas picker (`SharePanel`, Shell.tsx).
- Known v1 gaps: the bridge's chat→canvas / guest-owned-chat maps are in-memory (a recycle
  locks guests out of their pre-recycle chats, fails closed); `guestChat` links carry no
  turn budget (revocation is the only cost brake).

## Huddles (ADR 0017, issue #222 — decided, not yet built)

- **Huddle** — a voice room on one canvas (LiveKit room named by canvas id): participants
  talk over the board while the workspace's agent listens and acts on the canvas. Audio
  only; exists only while humans are in it. _Avoid_: "call", "meeting" (a huddle has no
  schedule, agenda, or lifecycle beyond presence).
- **Agent worker** — the agent's ears and mouth in a huddle: a Node `@livekit/agents`
  process in the workspace container running STT → Claude → TTS. Spawned by the bridge per
  huddle (single-flight per canvas), joins the room as the participant "cedar", exits when
  the last human leaves. Distinct from a **chat turn** (request/response Claude Code
  session): the worker is continuously alive while the huddle runs, and its brain is the
  raw streaming Messages API under the subscription OAuth token, not an SDK session.
- **Addressed** — the condition under which the agent speaks or acts: an utterance directed
  at it ("Cedar, …"), judged by the model from full conversational context, not a wake-word
  engine. Un-addressed speech is still heard (context) but answered with silence.
- **Huddle transcript** — per-speaker `{speaker, ts, text}` JSONL appended live by the
  worker; a byproduct of listening, not a recording feature. Audio is never recorded.
- **guestHuddle** — a Share Link capability (like `guestChat`): the link's guests may join
  that canvas's huddle through the sole guest gate, attributed under their guest identity.

## Deliberately deferred

- **Per-user Inbox read state.** `conversations.unread` stays a single row-level boolean
  meaning "new activity nobody has seen yet" — the first member to open the conversation
  clears it for everyone. A per-user `conversation_reads` table is the correct long-term
  shape but is deferred until the shared-inbox ambiguity is actually felt (decided
  2026-07-15 with the shared-inbox pivot).

- **Interactive components — DONE for controls.** The content has
  `pointer-events: all`, and a capture-phase pointer guard stops propagation only
  when the target is a control (`button,input,textarea,select,a,…`), so clicking a
  control reaches the component while clicking the card background still
  selects/drags the shape (`InteractiveBoxShapeUtil` + `predicates.ts` →
  `isInteractiveControl`, shared by `ComponentShape` and `ChatShape`).
  Still deferred: a component **reading/writing canvas state** (e.g. an
  Approve button that posts a decision back) needs a bridge channel from the
  component to the agent/store; not built.
- **Charting lib.** Components can already `import` any installed npm dep (mermaid
  is used); adding a charting lib (recharts etc.) to the deps is a one-line follow.
- **Production build.** The component path needs the vite dev server (it is the
  compiler), so a static `vite build` won't render newly-written components. The
  app is run-the-dev-server-locally anyway, so this is accepted, not fixed.
- **No dependency-graph reloads.** A library edit reloads *all* placed components
  (simple + correct) rather than only the dependents of the edited module.
- Viewport control, freehand-draw authoring by the agent, todo lists, and
  multiplayer (multiple humans). The tldraw **agent starter kit** is the reference
  for the fuller action set if we ever deepen this.
- **Workspace / multi-canvas** now has a resolved vocabulary and deploy grain
  (workspace=container, canvas=board; see the hierarchy section + [ADR 0001](./docs/decisions/0001-cloudflare-container-deploy.md)),
  but the bridge is still single-canvas — hosting multiple `CanvasStore`s per
  workspace is the fast-follow.
- A tldraw **production license** (the canvas shows a non-commercial watermark).
