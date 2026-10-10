# agent-canvas — domain model (normative)

A throwaway product POC: a **tldraw canvas with a built-in chat agent**. You draw
by hand; you also chat with an agent that draws on the same canvas and reads what
is there. The agent is driven by the **Claude Agent SDK** with a set of custom
canvas tools. It runs **locally** today (the agent needs an API/subscription
credential that can't live in the browser, and the component path needs the vite
dev server as its compiler), so this is not a Vercel deploy. It deploys to Cloudflare as
one `CanvasContainer` Durable Object per workspace (`worker/canvas-container.ts`, the
`durable_object` container policy) running the same dev stack — the shape
[ADR 0001](./docs/decisions/0001-cloudflare-container-deploy.md) designed, minus the
rollouts — or to a self-hosted VM for a workspace mapped in `SELF_HOSTED_WORKSPACES`.

## Workspace, canvas, chat — the containment hierarchy

**Workspace**: an isolated environment — one filesystem (the `src/canvas-components/`
library + the app code) and one bridge process. In the deploy it maps 1:1 to a
**container**; locally it is the single dev checkout. _Avoid_: "sandbox", "instance".

**Owner / member**: the two workspace roles (Better Auth `member.role`). A **member**
gets full workspace *use* (chat, agent, canvases); the **owner** keeps
workspace *administration* (invite/remove members, rename/delete). Deliberately no
finer grain: the container is one shared trusted runtime — anyone who can chat can do
anything the agent can, so the admission decision is binary. Access checks are
owner-OR-member (`getWorkspace`/`listWorkspaces`); the legacy `default` workspace has a
real owned row, no bypass. Only the owner invites — admission is a capability grant.

**Invitation**: an email-bound, single-use, expiring row (Better Auth `invitation`),
**emailed** to the invitee as a magic link since [ADR-0020](../../docs/adr/0020-passwordless-auth-on-cloudflare-email-sending.md)
(the link is still returned for copy-paste as a fallback). Holding one is what makes
an address eligible for a sign-in link, so an invitation is still the ONLY
account-creation door — but the gate is the allowlist in `sendMagicLink`, not
`AUTH_DISABLE_SIGNUP`, which is now inert. The account is created when Better Auth
VERIFIES the link; nothing in the accept handler mints a credential.
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

**Conversation / Inbox / Workspace events hub** — _retired 2026-10-09_: there is no
edge-side index of chat sessions, no assignment, no inbox badge and no events hub. A chat is
its card on a canvas. The `conversations` table and `workspaces.inbox_read_at` were dropped
in migration 0037; the `WorkspaceEvents` Durable Object class was deleted (wrangler
migration v6).

**Open PR** — _retired 2026-10-09_ with the dev agent: nothing opens or merges PRs.

**Visibility (canvas)** _(ADR-0016, decided + implemented 2026-07-17; its standalone-chat
half went with the Inbox)_:
a canvas is **workspace-visible** (default; today's behavior) or **private** —
private means only its **creator** (`created_by`, a new registry column) can see or
open it; everyone else, list and routes alike, gets the same 404 as a nonexistent
canvas. Flips are creator-only, both directions; the workspace owner additionally gets
**manage-not-read**: sees that a private canvas exists (name, creator) and may
force-publish or delete it, but cannot open it while private. Legacy canvases with
no recorded creator — and the registry-row-less `default` canvas — are permanently
workspace-visible. Share links still work on a private canvas (an explicit act by
its creator); MCP enforces the same rules via the token's user. _Avoid_: an
"admin" role (there is only owner/member), or treating private as an ACL
(it is a binary creator-only flag, not per-member sharing).

Containment: **workspace → canvas → page → shapes**, with **chat** shapes living on the
canvas like any other shape; a chat's `ChatMeta` and transcript live *beside* the canvas,
server-owned, not inside canvas state. (The tldraw **pages** layer was removed under
[ADR 0007](../../docs/adr/0007-workspace-platform-topology.md) and CAME BACK with the real
`TLSocketRoom` in #344 — tldraw owns page records again, so the canvas does have pages.)

**Console** — **DROPPED** _(removed in #454)_. ADR-0021 designed an owner-only terminal
into a Workspace's container; its `pty-server` was started on every boot but never routed,
and it went when chat turns lost every shell and filesystem tool. Reintroduce deliberately
if wanted.

## Core vs extension — the modifiability boundary

The codebase splits into two zones by who owns them (see [ADR 0002](./docs/decisions/0002-core-extension-split.md)):

**Core**: the code that must stay correct for the canvas to work — image-only, the agent must not modify it. Two parts:
- **Render Pad**: the container-served frontend — `App.tsx`, `sync.ts`, `ComponentShape`, the tldraw canvas + chat. The navigation chrome (rail, canvas selector) now lives in the edge **Shell SPA** (`shell/`, PRD #103), which iframes this pad. _Avoid_: calling a canvas-component part of the "pad".
- **Bridge** (a.k.a. **bridge core**): the single stateful backend process — the `CanvasStore`, persistence, the agent runner, the core `/api/*` routes. The authoritative owner of canvas state.

**Extension**: what the agent authors — hot-reloaded and persisted as **Records in D1**
(ADR-0022; the R2 tarballs and the sinks that wrote them were retired in #366):
- **Component** (`src/canvas-components/<Name>.tsx`): an agent-authored React module placed on the canvas. Already in use.
- **Custom handler** — **DROPPED** _(2026-07-29, removed in #357)_. An agent-authored backend handler at
  `server/custom/<name>.ts`, served by a separate extension-server process at
  `/api/custom/:handler`. Removed because it never had an authoring **door**: the tool surface
  has no `write_custom_handler`, and chat turns drop `Write`/`Edit` — so the only way to author
  one was `Bash`, the ungated path the QABoard lesson exists to prevent. It survived only
  because the old tar swept the whole directory. Under the Record model (below) an artifact
  with no tool cannot persist, and prod held zero of them, so the feature goes rather than
  earning a tool it was never given. Reintroduce deliberately, with a door, if wanted.
- **Workspace skill** (`.claude/skills/<name>/` under the package root): a user- or agent-authored skill dir (SKILL.md + supporting files), persisted per workspace as **Records** (`skill_files`, keyed workspace → skill → path — #361) and discovered via the SDK's `project` setting source from a tree rendered before each turn. Chat turns enable **all discovered** skills — no allowlist. Distinct from a **platform skill** (baked into the image at the container's `~/.claude/skills/`, the `user` source: deploy-versioned, PR-reviewed, unshadowable by workspace content). On a name collision the workspace skill wins. _Decided, not yet built._

A skill is **content-that-asks** — text the model reads. It is never a **capability** (a grant: tools, tokens, scopes, routing). Capabilities stay code-gated; no workspace data may confer one.

**Record vs File — how workspace content persists** _(ADR-0022, delivered by #354. LIVE as
**Records**: **both writable tiers** of Components — own and shared — with write, read,
version history, restore-to-version, on-demand materialization, promote and adopt (#355, #358,
#359, #362), their **data files** (#360), and **Workspace skills** (#361); the three-tier
**listing** is served from Records plus the build-time platform manifest (#363). The surviving
workspace content is moved in by the **backfill** (#365) — an allowlist of five files, not a
directory sweep, because the archives are otherwise e2e residue. The allowlist is **checked
against the archives** rather than trusted: every run enumerates every source archive and
refuses to write while anything in one is in neither the plan nor the not-migrated list. That
is not belt-and-braces — the first version of the list was stale within four hours, when a
Component authored in production landed in an archive the plan did not mention. A pinned hash
proves the bytes of a file we know about; only an enumeration proves we know about all of
them. LIVE as
**Files**: per-session **Transcripts** (#356) — that is their permanent home, not a staging
post. FINISHED by **#366**, which removed the machinery the whole workstream existed to
replace: the boot restore, the three remaining tarball sinks, their archive keys and load/save
methods, and the empty-archive guard.)_ The dividing
question is **who owns the schema**:

- A **Record** is content whose shape *we* define, authored only through our own tools —
  **Components**, their **data files**, and **Workspace skills** (already a files-only
  `{name, files:[{path, content}]}` wire format). Records live as **rows**, and the
  container filesystem is a **rendering** of them, materialized on demand so vite can
  compile. Truth is the row; the file is a cache. This makes structural what
  `disallowedTools` today only steers: an artifact with no tool has nowhere to live.
- A **File** is content a third party owns — the **Transcript**, written by the Claude Agent
  SDK in its own format and read back by `--resume`. We are its custodian, never its author,
  so it stays an opaque per-session object. Deriving it from rows would mean round-tripping
  someone else's undocumented format, and a subtly wrong round-trip breaks resume silently.
  (Consistent with ADR-0004: the JSONL is authoritative, the UI is a projection.)
  `TranscriptStore` (`server/transcript-store.ts`) is the sole custodian: a turn **puts** the
  one session it touched, a resume **materializes** the one session it needs, and **boot
  fetches none**. Granularity is the point — the retired `sessions.tar` re-uploaded the whole
  workspace's history every turn (49,111,040 bytes measured in production against ~650 KB of
  appends) and re-downloaded it at every cold boot.

**Boot fetches nothing** (#366, ADR-0022 decision 5). `scripts/container-start.ts` starts the
dev stack and does no filesystem work at all: a Component materializes when vite asks for the
module, a data file comes down with the Component that imports it, the skill tree is rendered
once per turn before the SDK scans it, and a Transcript is fetched by the turn that resumes it.
Deleting the step deletes the failure mode instead of guarding it — there can be no "boot
restored nothing" bug where there is no boot restore, which is why the **empty-archive guard**
went with it rather than outliving the write path it protected. It also removes an inversion:
resolution is **file-first** (the file answers for free on a warm container, the Record answers
after a recycle), and that is only correct while a file exists *because* materialization put it
there. A tarball landing on disk at boot would shadow a newer Record on every cold boot.
`server/boot-contract.test.ts` keeps the restore deleted.

**Fail-open must not return.** The root cause of 2026-07-29 was a read that failed, was
swallowed, and became the new truth. So: `TranscriptStore.materialize` — the one restore path
left — throws on a storage failure rather than answering "no history", and "nowhere" and "the
read failed" stay different answers; `TranscriptStore.put` writes nothing when the local JSONL
is absent, so a missing file can never overwrite a good object; and `materializeSkills` is the
one deliberate exception, degrading a turn to platform skills only, which is safe *because* it
writes nothing — the rows are untouched. A restore that cannot read must fail loudly, never
quietly agree that the workspace is empty.

The **platform tier stays image-only** and is neither: it is deploy-gated code, identical for
every workspace, versioned with the image that expects it. Making it a Record would demote
platform code to workspace data and break the **gated-layer rule**. So resolution is
`own → shared` (rows) `→ base` (the image), and the edge learns the base tier from the
**BaseManifest** rather than the container's disk.

**BaseManifest** (`worker/base-manifest.generated.ts`, generated by `scripts/gen-base-manifest.ts`,
#363): the platform tier's names and descriptions, walked out of `src/canvas-components/` at
**build time** and bundled with the edge Worker. It is **committed output** — which is the
second reason it exists: adding or removing a platform Component becomes a line in a pull
request instead of an invisible filesystem fact. `bun run build` regenerates it so a deploy
always ships one made from the image it is shipping, and `worker/base-manifest.test.ts`
regenerates and compares, so a stale committed copy fails the suite rather than rotting.

**The component LISTING is answered at the edge** (`worker/component-catalog.ts`, #363): own
and shared from Records, base from the BaseManifest, merged first-match-wins in that order so
the `tier` label on each entry is the tier that canvas actually **resolves** — the label is
load-bearing, because callers avoid duplicates with it and an edit follows it into a library.
Three doors reach the one implementation: `GET /api/components` (edge-served for members, so
the pad's gallery/palette and an in-canvas catalog card never wake a container), the inbound
MCP `list_components`, and the container's own `list_components` via the `component.list` RPC
verb. The container asks rather than reading its directories because after a recycle those
directories are empty while the Records are not — a disk-only listing would report an empty
library and the next turn would author a second copy of everything. `GET /api/components` for
a **guest** still proxies to the bridge, which answers from the same verb.

A Record write crosses the container/edge boundary as a **domain verb** on the platform RPC
(`component.write` / `component.read` / `component.history` / `component.restore` /
`component.list` / `component.promote` / `component.adopt`, `data.write` / `data.read`,
`skill.write` / `skill.list`), never a generic row op — the RPC is a behavioural contract, not
a SQL tunnel — and the **edge** validates the name and paths, and ownership-checks the canvas
(Components, data files) or the workspace (skills), rather than trusting the container's
payload. Ordering is **store first, then disk**: a write that cannot be persisted fails the
tool call, and the file it then writes is only an HMR trigger.

A **data file** is a Record of the same family as the Component that imports it (one table,
`kind: 'data'`) but its own verb, because what makes it valid is different: a closed,
non-executable extension set (`.json/.csv/.txt/.md`), `.json` that must parse, and a size cap
**derived from what the store can hold** — half of D1's 2,000,000-byte row/value ceiling. (The
old 1 MiB cap was justified by a tar sink that no longer exists; the ceiling is the only
reason left.) A data file also never materializes on its own schedule: vite resolves
`./sales.json` against the **filesystem** while it transforms the module importing it, so a
Component comes down **with the siblings its source imports** — a Component that arrived alone
would fail import analysis and render a dead card.

The shared tier is `canvas_id NULL`, which has no canvas for that ownership check to look up —
so **every** Component verb names the canvas it is acting FROM, including a shared one, and the
edge mints the null itself: a workspace's shared library is reachable only by naming a canvas
the registry places inside it, which is the same check an own-tier write already passes. (That
is also why a shared module's dev-server URL carries `?c=<canvasId>`: materializing it goes
through the edge.) Skills have no canvas at all, so they fall back to "the workspace is real".
Both are **consistency** checks, not tenancy checks — the platform-RPC bearer is a constant
with no workspace identity in it, so neither can stop a caller that names a real, coherent
workspace it does not own (#374).

**Materialization timing is not uniform, and the difference is the point.** A Component is
materialized **lazily**, when vite requests the module — the client already walks own → shared
→ base and retries with backoff, so a miss is a normal path. A Workspace skill has no such
request: the agent SDK discovers skills by **scanning** `.claude/skills/` as it builds a turn's
options, so its tree is rendered **eagerly, before every turn starts** (`server/skills.ts`,
called first in `server/turn.ts`) — the one moment that is both after a possible recycle and
before discovery. A skill file that is absent then is simply not a skill for that turn.

**Version** and **attribution** are properties of the store, not of a caller. Every `put`
appends a version row — an invariant, because a caller that can forget it is how "no history"
comes back. Three semantics worth knowing: an identical rewrite **still** appends (a write is
an *event*, not a diff — `rev` counts writes, and "nothing changed" is for a reader of the
history to conclude, not for the store to decide by forgetting); a soft delete **keeps** the
history (that is what makes soft delete safe); and an undelete **continues** the sequence
rather than restarting it. History is read back with `component.history` — newest first, and
deliberately **without** the source, so "what happened to this" does not cost every revision
of the text. The agent's door to it is the `component_history` tool.

**Restore** is what makes that history *recovery*: `component.restore` names a version and
puts its source back as the current one, through the `restore_component` tool. Three
properties, each deliberate. It is a **forward write, never a rewind** — it appends a further
version instead of truncating the ones after the chosen point, so nothing is erased and the
restore is itself undoable; a "recover" that destroyed history would just be a second way to
lose work. **The source never enters the container**: the caller names a *version*, and the
read-then-put happens entirely at the edge, so the text stays on the side that owns the rows,
a container cannot forge a restore by composing a payload, and a large Component is not
shipped across the hop twice. And because a restore is a `put`, it **undeletes** — recovering
a soft-deleted Component is the same one operation, not a second verb to discover. A version
that does not exist is a 404 and writes nothing; the restore is attributed to whoever
performed it, not to the author of the text it brought back.

_Attribution is per request: the human who started the write._ The edge stamps
`x-canvas-author` (the gated `user.id`) on every member write and on the MCP proxy's
synthetic calls (the OAuth token's user), and strips any client-sent copy. A direct write
binds its Record store to that author; a chat send carries it into the turn, whose authoring
tools write as it — and a turn one chat card starts in another keeps it. Unknown — a guest,
the voice agent — is **null**, never a fixed id or a `'default'` placeholder: a version row is
the permanent answer to "who changed this", and a name no user query will ever match is a
history that *looks* attributed and is not. The container is handed no user identity at all.
The **backfill** (#365) writes with **no** author for the
same reason: a migration is not a person, and a synthetic id in a column typed as a user id
would be exactly the history that looks attributed and is not. Its provenance is the version
row itself — v1, stamped at the time the backfill ran.

**Deleting a canvas is a soft delete; the purge is a separate act.** `DELETE /api/canvases/:id`
soft-deletes the canvas's **own tier** — Components *and* their data files, which are the same
family of Record and would otherwise be orphans nothing lists. The **shared library** is
`canvas_id NULL` and belongs to the workspace, so it is never in a canvas's scope; **Workspace
skills** are workspace-scoped too and are untouched. Nothing about a canvas deletion reclaims
anything: `POST /api/workspaces/:id/records/purge` is a request of its own, **owner-only**, and
it acts only on rows that were already deleted — it takes their **versions with them**, because
the versions hold the same source and a history whose Record is gone is one nothing can restore
from. That asymmetry is the design: delete must be honest in both directions, and before this
*nothing* removed a deleted canvas's components — the source survived by accident and leaked
forever — while a hard cascade would have made one click destroy source permanently, the exact
shape of 2026-07-29.

_Avoid_: "we tar the workspace" (there is no tar — the sinks, their keys and the boot restore
were all removed in #366), or treating the filesystem as the durable copy — that inversion is
what destroyed every own-tier component on 2026-07-29.

**External MCP** (the agent consuming outside tool servers) follows the same line. The **MCP registry** (code, PR-gated, global) is the catalog of approved remote HTTP servers — the trust decision that cedarpad may talk to an endpoint at all. **Enablement** is per-workspace and is an act of owner consent (v1: paste a per-workspace bearer token at connect time; later: an OAuth dance — a registry entry declares its auth kind). **Token custody is edge-side**: per-workspace credentials live in the worker's DB, are attached as a header on the proxied `/send`, and are used for that turn only — the container and R2 never store them. A workspace that hasn't connected a server gets no tools, no token, and no connection attempt; an unreachable server degrades that turn's toolset, never fails the turn. Chat flavor only; dev-agent turns get no external MCP servers.

**Repo**, **Repository connection**, **Job**, **Gated-layer rule** — _retired 2026-10-09_.
The canvas never changes code, so a workspace has no repos, no GitHub connection, no jobs and
no token-holding turn for a gated layer to protect.

**Inbound MCP** (outside agents interacting with a workspace) is the only supported programmatic surface — there is deliberately no inbound REST/turn API (a service credential that can execute turns is an RCE credential; MCP's OAuth keeps the boundary at humans delegating to their own agents). The server runs at the edge; a token acts as its user, and every tool is ownership-checked per workspace. Every tool is **content + read** (`upload_skill`, `read_canvas`, `write_component`, …): since the Inbox was retired (2026-10-09) there is no MCP tool that starts or reads a chat turn — an outside agent changes the canvas directly, through the same tools the in-canvas chat uses. `create_canvas` uses the same registry create as the shell route. Mutations funnel through the bridge (single writer of the workspace tree — `upload_skill` proxies to a bridge endpoint and wakes the container); only pure reads are served edge-side.

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
 browser (tldraw + chat)         edge Worker (workerd)          bun bridge + Agent SDK
 ───────────────────────         ─────────────────────          ──────────────────────
  human draws ─────WS──────▶  ┌──────────────────────┐
  presence     ◀────WS──────▶ │ CanvasSyncRoom (DO)  │ ◀─HTTP──── CanvasStore facade
  chat ──POST /chat (SSE)──────│  TLSocketRoom        │  /mutate   (src/remote-store.ts)
                              │  room state in DO    │              ▲
                              │  SQLite              │              │ tool calls
                              └──────────────────────┘        create/update/delete/read
                                 ONE room per canvas, globally.
                                 Human and agent write the SAME room,
                                 so agent edits stream to the browser live.
```

The canvas document lives in the **Durable Object**, not the bridge (ADR-0019). The
browser is a `useSync` client; the agent writes over an authenticated HTTP mutation
endpoint on the same DO. `CanvasStore` (`src/store.ts`) is still the seam every agent
tool talks to — `src/remote-store.ts` implements it against the room, so `canvas-ops.ts`
never learned the document moved.

- The **bridge** (`server/bridge.ts`) runs the agent and serves `/api/chat`. It no
  longer owns canvas state: since ADR-0019 the document is the DO's, and the bridge
  opens a short-lived `CanvasStore` against the room per tool call (open → mutate →
  flush → discard).
- The **browser** (`src/`) is a pure client: a full-bleed tldraw editor synced by
  `useSync` against the room. Chat lives **in the canvas** — each session is a
  `chat` shape (`src/ChatShape.tsx`); a floating "New chat" control spawns one.
- Dev runs both with `bun run dev` (bridge :4511, vite :4510; vite proxies
  `/api/*` → bridge).

**Push plane** ([ADR-0023](../../docs/adr/0023-push-planes-split-by-volume-and-ownership.md)):
a channel the server pushes over. There is more than one, deliberately and boundedly — **a
new plane is justified only by a difference in message VOLUME or in who OWNS the state, never
by a new feature.** High-volume ephemeral streams get a direct path (turn output from the
container; canvas ops over sync). The low-volume notification plane (the per-workspace events
hub) went with the Inbox on 2026-10-09; if one is needed again, ADR-0023's rules for it still
apply — thin topic-only notices, coalesced. Within a plane, multiplex by topic — one stream
per client, not one per feature.

The deciding question is **who owns the state, not what the state is about**. The tiebreaker:
**anything that must survive the container sleeping cannot live on the chat plane.**
_Avoid_: a per-feature `/api/*/events` endpoint.

> Live presence (#212) was a bespoke heartbeat with **throttled** SSE frames; #293 moved it
> onto sync and deleted the transport — taking the throttle with it, and the hub was built
> without one until review caught it. **Transport-specific safety machinery dies with its
> transport.** That is why this rule lives here and not only beside a socket.

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
- **A canvas HAS pages** (#344). Every shape may carry an optional **`page`** (a tldraw
  `page:...` id), and the read path reports the canvas's pages as an ordered
  `CanvasState.pages` of `{id, name}` (`worker/canvas-mutate.ts`). Two rules carry the
  feature:
  - **Absent means the FIRST page.** `pages[0]` is the page the switcher opens on, so a
    shape with no `page` reads and writes exactly as it did before pages existed — which
    is nearly every shape on nearly every canvas. A shape's page is resolved by walking up
    through any containing frames, since a framed shape's `parentId` is the frame.
  - **An unknown page is REFUSED, never redirected.** Quietly landing a write on the
    default page is the failure that looks like data loss: the human asked for page 3, the
    agent said it wrote, and nothing is there.
  Reads may narrow to one page (`read_canvas`'s `page`, filtered at the BRIDGE via
  `shapesOnPage` so a busy board never crosses the hop the MCP response limit measures).
  Page ids are opaque and nothing else hands one out, which is why every read reports them.
  Page NAMES are the human's — neither stable nor unique — so resolving one to an id is
  `shared/canvas-pages.ts`, at the tool layer, and an ambiguous name is refused with the
  candidates rather than resolved to the first match. The room itself speaks ids only, and
  so does the `page` FILTER: only `select_page` takes a name today.
- **Which page you are LOOKING at is not document state.** It is per-client tldraw
  instance state, so it cannot travel over sync. `select_page` (both agent surfaces) moves
  one person's editor over the bridge's SSE plane, addressed by the edge-stamped
  `x-canvas-viewer` — **presentation only, never an authorization input**: writes still
  authorize as `CONTAINER_PRINCIPAL`, and the bridge stays identity-blind for every other
  purpose. Absent viewer (a guest, whose per-browser id never reaches the edge; a headless
  send) means the capability is **withheld**, not widened — a fan-out
  with no viewer moves nobody, never everybody. _Avoid_: reading that header to decide
  whether something is allowed, and any "move everyone" fallback.
  - **The edge is its only writer, on every path.** It is set on a send and on the canvas
    stream subscribe, and **set-or-DELETED** everywhere else — in `worker/index.ts` for the
    authenticated and guest paths. Miss one and a member can aim an agent at a colleague's
    screen.
  - **The result counts DELIVERY, not application** (`asked`, not `moved`): the leg is
    fire-and-forget and a browser declines a page it has not synced yet. Only `asked: 0`
    is certain. Agent-facing wording says "asked … to switch", never "switched".
  - **Absent pages ≠ one page.** `CanvasState.pages` is optional because the in-memory
    store models none; a state that reports none has said *nothing* about how many exist —
    never render that as "this canvas has a single page".
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
  using a deterministic `imageAssetId(shapeId)`). **Pixels no longer ride inline on the
  wire**: since ADR-0019 the room's asset records carry a URL and the bytes live in R2
  behind `/api/canvas-assets/:canvas/:key` (`worker/canvas-assets.ts`). Inlining base64
  into records would put images in DO SQLite and rebroadcast them on every sync — the
  "revisit if images get heavy" note this replaces.
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
- **Components can talk back to their chat (`sendToAgent`, the reply target)**: every
  instance also receives a `sendToAgent(message)` prop bound to its **reply target** —
  the chat the card is attached to (its inbound `attachBatchToChat` arrow), resolved fresh
  at send time by `resolveReplyTarget` (`src/reply-target.ts`): the linked chat is
  authoritative, else the focused card, else it refuses rather than posting to a stale or
  wrong chat. The message rides the same `/api/chat/<id>/send` route the card uses, so the
  reply streams back into that card. `activeChatId` (`src/agent-link.ts`) now tracks only
  the *focused* card — the fork anchor and that fallback — never the reply target itself.
- **Live presence (#212, moved onto sync by #293)**: **both** transport and rendering
  are tldraw's now. `useSync` takes a `users: TLUserStore` built from our identity
  (`createCanvasUserStore`, `src/presence.ts`) and the protocol carries presence. The
  bespoke heartbeat — `POST /api/canvas/presence`, `server/presence.ts`, the throttled
  `event: presence` SSE frames — is **deleted**; only the identity mapping survived.
  tldraw's built-in collaborator UI still does the rest: labeled cursors, the people
  face-pile (`DefaultSharePanel`/`DefaultPeopleMenu` in `App.tsx`), and click-to-follow
  via `startFollowingUser` (auto-unfollow on local pan/zoom).
  Two things worth keeping in mind: tldraw **brands user ids** and rejects an
  unprefixed one at record validation (closing the socket), so `createUserId` in
  `tlUserFor` is load-bearing; and presence records must never reach persisted room
  state — the room guarantees it, and `worker/sync-room.test.ts` pins it.

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
- An optional `onChange(state)` fires once per real mutation. Since ADR-0019 / #297 the
  bridge no longer subscribes to it: the in-memory `createStore` is the **test double**
  behind the agent-tool suite, and production writes go through `RemoteCanvasStore` against
  the canvas's room, which is what every browser reads.

## Bridge protocol (`/api`)

| route                     | method | purpose |
|---------------------------|--------|---------|
| `/api/canvas`             | GET    | current `{version, shapes}`, read from the canvas's room |
| `/api/canvas/stream`      | GET    | SSE; carries the agent's `screenshot` ask and nothing else (#297) |
| `/api/canvas/shapes/create` | POST | `{shapes}` create, into the room |
| `/api/canvas/shapes/update` | POST | `{shapes}` patch, into the room |
| `/api/canvas/delete`      | POST   | `{ids}` delete, from the room |
| `/api/chat/stream`        | GET    | SSE; **one stream for ALL chats**, each frame tagged with `chatId` |
| `/api/chat/:id/send`      | POST   | `{message, sessionId?, images?}` → 202; events **broadcast** (tagged) to subscribers; **425** when no chat stream is subscribed |
| `/api/health`             | GET    | `{ok}` (liveness; the shape count went with the in-process store, #297) |

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

**A chat turn has no shell and no filesystem tools** (`CHAT_TOOLS` in
`server/agent.ts`: Skill, WebSearch, WebFetch, TodoWrite). A plain Write would drop an
unregistered file — unserved, never hot-reloaded, invisible to `list_components` (the
QABoard incident) — so component and data files may only be authored through the
registered tools (`write_component`/`edit_component`/`write_data`, which persist the
Record and bump the rev). Every change a turn makes goes through an MCP tool.

The agent's "thinking" and replies to the human are its normal chat text — not a
tool. The human watches shapes appear in real time over the sync room while the
text streams on the chat channel. Shapes land **per tool call**, not at the end of
the turn: the turn's store settles after every tool (#310), so a long turn draws
progressively and a failed write surfaces as that tool's own error.

**`send_message` (cross-chat)** — a chat turn may post a message into ANOTHER
chat card's thread on its canvas and kick that card's turn (parity with the edge
MCP's `send_message`). Bridge-bound seam (ChatMeta + the turn dispatcher),
fire-and-forget: the reply streams into the target card, the sender polls
`read_canvas`/`read_connected`. Guard rails: no self-send, the target must be a
chat card on the sender's canvas, an in-flight target refuses (one turn per
chat), and the delivered message is prefixed `[from <chatId>]` so the receiving
thread knows who is speaking.

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
  (`componentUrls`, ADR-0014) — so promote is a change of *tier* with no store rewrite
  (`server/components.ts` `promoteComponent`, over the Record store since #359: one row
  relocated, never a write-then-delete, because a half-done promote used to leave the bare
  name resolving onto a same-named PLATFORM module and rendering the wrong card silently),
  instances stay stable,
  and another canvas placing the same bare name gets the one shared source. Editing a shared
  module bumps the rev on the **caller's** canvas. (The cross-canvas fan-out over the
  bridge's in-memory session registry went with the old sync plane in #297 — it bumped
  stores no browser had read since #290. Other canvases re-import a changed shared module on
  their next load. `bumpSharedModule`/`sessionsPlacingModule` remain in `canvas-ops.ts`,
  unwired, awaiting a room-based fan-out.) `adopt_shared_component` copies a
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
- Seed library (also the agent's reference for conventions): `MarkdownCard` (leaf, takes
  props), `ChartCard` (a Flint spec as props), `MermaidDiagram` (real `mermaid` import,
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

## Sync invariants (ADR-0019)

The hand-rolled reconcile loop is gone. `src/sync.ts` and `src/sync-plan.ts`
(`planReconcile`, the 80ms debounced POST, the in-memory version counter, the
`onopen` high-water reset) were **deleted** — echo-safety, ordering, conflict merge,
and reconnect/resume are the sync protocol's job now, not ours. What remains ours:

- **Room uniqueness is load-bearing.** Exactly one `TLSocketRoom` per canvas globally;
  the Durable Object is that guarantee. Never host the same canvas twice.
- **Referential integrity is ours.** Sync-core contains *zero* binding logic — that
  lives at Editor level, and a DO has no DOM. So the write path sweeps binding records
  itself (`worker/canvas-mutate.ts`), inside the same `updateStore` transaction as the
  delete. Deleting a bound shape leaves **the arrow, unbound** — matching tldraw's own
  `ArrowBindingUtil.arrowDidUpdate`, because a human and an agent write the same room
  and the server must not answer the same event differently from the client.
- **Arrow bindings are separate `binding` records, not shape props** (tldraw v5) —
  unchanged, and now the reason the point above exists.
- **Validate anything entering the room from outside.** `updateStore()` validates via
  `recordType.validate`; `storage.transaction`'s `txn.set` and `loadSnapshot()` do
  **not**. An invalid record is accepted and then breaks every client that opens the
  room. A round-trip test proves symmetry, not validity.
- **Minted shape ids are random, not sequential** — `shape:agent_<16 hex>`
  (`src/normalize.ts`, #327). A counter is only unique within one process, so two
  containers writing one canvas mint the same next id and the second flush upserts over
  the first: an upsert where a create was meant, reported as success. Priming the counter
  from room state (#324) closed the cold-container case but not that one, and is gone.
  Existing `shape:agent_<n>` ids are never rewritten and still address their shapes.
  Because the ids are no longer guessable, `create_shapes` / `place_component` return
  every id they mint and say so in their descriptions. Still open by other routes: a blind
  upsert onto an already-occupied id (a stale or hand-written id) overwrites and reports
  success — the mutate contract has no create-vs-update distinction.

## Guest share links (ADR 0015, PRD #220 — live)

- **Share Link** — a member-minted, revocable capability row (`share_links`, D1) granting
  outsiders access to exactly one canvas, with per-link permissions
  `{guestChat, guestHuddle, guestInteract, guestEdit, guestEditSource}` (see Guest
  Capabilities below). No default expiry; lives until revoked.
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
- **Guest Capabilities** (#320) — what a link permits, as three per-link booleans beside
  `guest_chat`/`guest_huddle`: **`guest_interact`** (use a live component: click the button,
  submit the form — defaults ON, backfilled ON), **`guest_edit`** (edit the canvas document:
  create/move/delete shapes — opt-in), **`guest_edit_source`** (`PUT /api/components/:module`,
  **own/canvas-scoped tier only** — opt-in). Three separate grants, never one ordered level:
  they are different kinds of risk. `promote`/`adopt` stay denied under every flag (they reach
  the workspace-shared tier, outside the invite). `shared/guest-capabilities.ts` is the ONE
  place a link row becomes a decision — three doors derive from it, and #297 exists because
  they used to each decide for themselves.
- **Guest writer identity** — a guest writes as `guest:<sessionId>`, minted per WebSocket
  connection in the Durable Object, so two guests on one link are two authors. Guests are
  first-class writers on the SAME socket members use, with the capability set established at
  the HANDSHAKE (a live guest holds what they had at connect time). There is no HTTP mutate
  door for guests: those wrote to the room under the container's service credential, which
  was the #297 bug.
- Enforcement layers: `worker/guest-gate.ts` (pure default-deny path allowlist at the edge,
  per-request revocation recheck, capability-driven since #320) + the sync handshake
  (`worker/sync-api.ts` → read-only unless the link grants interact or edit; per-message
  narrowing for interact-only sessions in `worker/guest-socket-policy.ts`, because tldraw
  sync's only per-session knob is read-only) + the bridge's `x-guest-canvas` / `x-guest-caps`
  confinement (SSE frame filter, member-conversation view-only rule, the own-tier check on
  component source, guest turns are plain chat turns). Member surface: the Share panel in the
  canvas picker (`SharePanel`, Shell.tsx).
- **Guest marking** (#320) — a guest names themselves on arrival (`GuestNamePrompt`,
  `setDisplayName`) and presence renders them as "<name> (Guest)". The mark rides tldraw's
  own `userName`, so the cursor label and the people list carry it without a second visual
  language. Load-bearing, not chrome: revocation is a manual judgement call, so a member has
  to notice an outsider is editing before they can act. Client-supplied and unverified — it
  is a display name, never an authorization input (that is `guest:<sessionId>`).
- **Revocation** — a tombstone on the row (stops the next connect) AND an eviction of the
  link's OPEN sockets (`evictGuestSockets` → the DO's `/evict`, `socketsForLink`). Both,
  because capabilities ride the handshake: the tombstone alone leaves the guest who is
  connected right now writing with what they had. Contributions stay — removing them is a
  merge conflict, not a delete; the per-session identity is what tells you what to remove.
- Known v1 gaps: the bridge's chat→canvas / guest-owned-chat maps are in-memory (a recycle
  locks guests out of their pre-recycle chats, fails closed); `guestChat` links carry no
  turn budget (revocation is the only cost brake).

## Huddles (ADR 0017, issue #222 — live)

- **Huddle** — a voice room on one canvas (LiveKit room named by canvas id): participants
  talk over the board while the workspace's agent listens and acts on the canvas. Audio
  only; exists only while humans are in it. _Avoid_: "call", "meeting" (a huddle has no
  schedule, agenda, or lifecycle beyond presence).
- **Agent worker** — the agent's ears and mouth in a huddle: a Node `@livekit/agents`
  process in the workspace container running STT → Claude → TTS, all three through **LiveKit
  Inference** (`deepgram/nova-3` STT, `inworld/inworld-tts-2` TTS) — turn-taking rides
  Deepgram's server-side endpointing, so there is **no local VAD** in the container. Spawned
  by the bridge per huddle (single-flight per canvas, 4h backstop kill), joins the room as
  the participant "cedar", exits when the last human leaves (humans-only liveness with a
  grace period). Distinct from a **chat turn** (request/response Claude Code session): the
  worker is continuously alive while the huddle runs, and its brain is the raw streaming
  Messages API under the subscription OAuth token, not an SDK session. It reaches the canvas
  through five localhost bridge tools, and logs to `/tmp/huddle-<canvas>.log` (bridge stdout
  is lost).
- **Addressed** — the condition under which the agent speaks or acts: an utterance directed
  at it ("Cedar, …"), judged by the model from full conversational context, not a wake-word
  engine. Un-addressed speech is still heard (context) but answered with silence.
- **Huddle transcript** — per-speaker `{speaker, ts, text}` JSONL appended live by the
  worker; a byproduct of listening, not a recording feature. Audio is never recorded.
- **guestHuddle** — a Share Link capability (like `guestChat`): the link's guests may join
  that canvas's huddle through the sole guest gate, attributed under their guest identity.
- Member surface: the **Huddle section** in the side panel (`src/huddle.tsx`, above "On this
  board"); guests get a fab behind `guestHuddle`. The connection lives in a module manager,
  so it survives panel collapse — hiding the panel mid-huddle leaves a floating card. A
  status overlay shows cedar's live state (listening/thinking/speaking), peers, and captions.

## Deliberately deferred

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
