# The platform data layer moves to D1, and the container has no database

Status: accepted (design). Amends [ADR-0008](./0008-workspace-is-a-deployment.md) — which named
Turso in its tenancy rationale — without changing its decision. Vocabulary: root
[CONTEXT.md](../../CONTEXT.md) ("Platform data layer").

The **platform data layer** (schema, query modules, migrations under
`packages/canvas/web-poc/lib/db/`) moves from **Turso to Cloudflare D1**. The workspace
**container keeps no database client at all**: the edge pushes rows down through the existing
proxy, and the two container-initiated writes go back to the edge over a narrow typed RPC.

## Why

We want one vendor. Everything else in the stack is already Cloudflare — Worker, Durable Objects,
R2, Containers, and the `WAITLIST` D1 the `www` worker owns. Turso was the single exception.

The obstacle was never the data. It is a few hundred rows (3 users, 1 workspace, 20 canvases, 42
conversations), both sides are SQLite, and there are **no interactive transactions anywhere** in
`server/`, `worker/`, or `web-poc/` — the usual D1 blocker does not apply.

The obstacle was the **runtime split**. D1 bindings exist only inside workerd; a Bun process in a
Container cannot hold one. Turso was reachable from both runtimes because it is HTTP + token. That
is *why* it was there, and any move to D1 has to answer for it.

It turned out the container barely needs the database:

- The **Notebook is already served at the edge** (`worker/index.ts:270`, ADR-0007 #56) — "Notebook
  no longer depends on / wakes the container". The container's `buildApp` mount (`bridge.ts:131`)
  is reachable only when something talks to the bridge directly, i.e. **local development**.
- **`dev-agent-workflow.ts` touches no database** — its only import is a *type*. The work that is
  irreducibly container-shaped (spawning Claude Code, git worktrees, subprocesses) makes zero
  database calls.
- The edge proxy **already loads the Conversation** and ownership-checks it
  (`worker/inbox-bridge.ts:69`), and already forwards fields from it into the proxied request
  (`:118`, `CANVAS_ID_HEADER`). The bridge's `conversations.get` was a redundant second read of a
  row the edge had just fetched.

That leaves only two genuinely container-initiated writes.

## Decision

- **D1 is the platform data layer's store**, bound to the edge Worker. One database per Workspace
  deployment, consistent with ADR-0008 — each deployment gets its own static binding, which is how
  D1 wants to be used.
- **The container holds no database client.** `worker/container-env.ts` stops forwarding
  `TURSO_URL`/`TURSO_KEY`; deleting those two lines *is* this decision.
- **Reads and edge-initiated flows push down**: the edge forwards already-fetched rows through the
  proxy, extending the pattern at `inbox-bridge.ts:118`.
- **The container-initiated writes go back over a typed RPC.** This design named two —
  "find-or-create the conversation for this session" (`indexSessionStart`) and "send a push
  notification". Implementation (#266) closed the surface at **four**: `conversation.start`,
  `conversation.settle` (the settle-time backstop), `turn.end` (the `end_turn` declaration), and
  `notify`. The extra two are the same kind of thing — chat-lifecycle, best-effort, no row
  returned — and they were simply the call sites that still had a local client when this was
  written. All are already documented best-effort (`bridge.ts`: *"an index failure never fails the
  turn"*), so a failed hop degrades exactly as a failed Turso write does today. One zod contract
  at the boundary (guideline 7). It is a **behavioural** surface, deliberately not a data-access
  layer or a SQL tunnel, so it cannot quietly grow into one.
- **`Database` widens to the shared Drizzle SQLite base type** (`lib/db/client.ts:6` is currently
  `ReturnType<typeof makeDb>`, i.e. libSQL-specific), so the 10 query modules stay driver-agnostic
  and compile untouched.
- **Cutover imports data only.** This design originally said "a verbatim dump — schema and data
  including `__drizzle_migrations`", which assumed drizzle-kit would own D1's migrations.
  Implementation (#265) made **wrangler** the schema authority instead: `deploy.sh` runs
  `wrangler d1 migrations apply`, whose ledger is `d1_migrations` (already populated with all 26).
  Restoring Turso's `__drizzle_migrations` on top would leave two competing ledgers in one
  database. So the schema comes from wrangler and **only table rows** are imported — skipping both
  ledgers. Existing sessions still survive (they are ordinary rows), so there is still no forced
  logout. **Turso stays live and untouched** afterwards; rollback is flipping `PLATFORM_DB_ENABLED`
  back to `"false"` and redeploying — not a restore.
- **The cutover is an explicit flag, not a binding.** #265 found that treating the *presence* of a
  `PLATFORM_DB` binding as the switch would make merely deploying a binding repoint production at
  an empty database — a cutover performed by accident. `createDbForWorker` now requires
  `PLATFORM_DB_ENABLED === "true"` as well, so the binding can ship inert and the cutover is one
  deliberate, revertible act.
- **Local dev runs the edge Worker** with miniflare's local D1, so dev stops simulating the
  datastore. Per-worktree isolation (guideline 6 / ADR-0003) moves from `CANVAS_DEV_DB` to a
  per-worktree `.wrangler/state`; `with-worktree-db.sh` is rewritten, not repointed.

## Consequences

- **Local dev is heavier** — the edge Worker now runs alongside vite and the bridge, where the
  bridge alone used to be enough.
- **Boot-time auto-migration goes away.** `bridge.ts:123` runs `migrate()` on every local boot
  today; that becomes an explicit `wrangler d1 migrations apply --local`. Worse ergonomics, better
  prod parity.
- **Two flows gain a network hop.** Both are chat-lifecycle, human-speed, and best-effort — nothing
  on the canvas hot path.
- **A new failure mode**: the container can now fail to reach the edge. It degrades the same way a
  Turso outage does today, but the dependency is ours rather than a vendor's.
- **Gained**: D1 Time Travel (30-day point-in-time recovery), which Turso was not giving us.
- **Blast radius ~20 files**, listed in the migration issue — mostly mechanical config and env
  plumbing.

## Considered and rejected

- **Keep Turso.** Zero work, and it genuinely solves the dual-runtime problem. Rejected for
  single-vendor consolidation — a strategic choice at 3 users, not a performance one.
- **`drizzle-orm/sqlite-proxy` from the container to a worker SQL endpoint.** Smallest diff: one
  construction branch, all call sites untouched. Rejected because it means an internal endpoint
  executing arbitrary SQL — a standing hazard — to serve flows that turned out to need only two
  named operations.
- **D1's REST API from the container.** That is the admin API: rate-limited, not a datastore path.
- **Disabling the Notebook to remove the container's database need.** Offered and *withdrawn* once
  we found the Notebook already runs at the edge. It would have cost one of the three Apps in the
  normative model and bought nothing.
- **A Durable Object per workspace as the platform store.** The right Cloudflare answer *if* one
  shared Worker had to serve many workspaces from many databases — D1 bindings are static and
  cannot be chosen per request. Not our shape: ADR-0008 makes a Workspace its own deployment, so a
  static binding per deployment is correct. Revisit only if that tenancy model changes.
