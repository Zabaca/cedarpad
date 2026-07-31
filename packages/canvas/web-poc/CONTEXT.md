# web-poc — Cedarpad Problem/Solution intelligence (in-tree module of canvas)

A React **SPA** + a **Hono** API backed by the platform D1 (ADR-0018) with Voyage
embeddings. Migrated from the standalone `apex` monorepo (API Worker + Pages SPA + 5
workspace packages) into its own package, then — as of 2026-07-01 — **merged into
`@cedarpad/canvas`** at `packages/canvas/web-poc/`.

**It is no longer a standalone worker or a package.** Canvas's edge Worker serves
its Hono app directly (ADR-0018), canvas's Vite serves the SPA, and prod ships as
one Cloudflare instance. There is no `package.json`/`exports` — canvas imports it
by relative path and owns its dependencies. See "How canvas mounts it" below.

## Language

> Agreed 2026-07-30 ([ADR-0024](../../../docs/adr/0024-the-notebook-is-an-agent-first-store.md)).
> The Observation side of this is built: `sources` is a table, `observations.origin`
> replaced `observations.source`, and the similarity graph is gone. `problems.source`
> is the one word still waiting on its own slice.

**Observation**:
A loose record of something worth noting, which may lead nowhere or pile up with
others until a Problem emerges.
_Avoid_: note, entry, item.

**Problem**:
A specific, weighted, urgent thing that a pile of Observations points at, and that
is expected to be resolved.
_Avoid_: issue, ticket — those are GitHub things (ADR-0015).

**Source**:
Where an Observation came from — a URL, a call, a document, or a cedarpad entity (a
Conversation, a canvas, a repo). A row, not a sentence; when there is nothing to
point at, it carries a description instead.
_Avoid_: using "source" for who produced a record — that is **Origin**.

**Origin**:
Who produced a record: `human` or `agent`. Distinct from **Source**, which is where
it came from.

**Solution**:
A resolution attached to an Observation or a Problem.

## Relationships

- A **Source** has many **Observations**; an Observation has at most one Source
  (nullable — an Observation you simply think of has none)
- Many **Observations** feed a **Problem**, and an Observation can feed several —
  many-to-many. The tie carries a relevance, a rationale, and the **Origin** that
  drew it; removing it leaves both ends standing
- A **Problem** links to other **Problems**, written deliberately, never inferred
- A **Solution** attaches to an **Observation** or a **Problem**

## Example dialogue

> **Dev:** "An agent notices something during a dev-agent run and records it. What's
> the **Source**?"
> **James:** "The Conversation — a real id, not a sentence describing it. And the
> **Origin** is `agent`, because the agent typed it. Two different questions."
> **Dev:** "The same complaint arrives on a call and in a ticket — one **Observation**
> with two **Sources**?"
> **James:** "Two Observations. That they're the same thing is what synthesizing them
> into one **Problem** says."

## Flagged ambiguities

- "source" meant both *who produced this* and *where it came from* — resolved: those
  are **Origin** and **Source**, and they are different columns.
- Root CONTEXT.md says Notebook records are isolated per platform workspace; the
  surviving graph reads in `lib/db/queries/graph.ts` (problem context, neighborhood,
  solved neighbours) still are not — resolved: **isolation is the rule**, one shared
  pool *per workspace*, and those unscoped reads are a defect to close.

## Layout

- `src/` — the React 19 SPA (Mantine, React Query, zustand, Better Auth client,
  openapi-fetch, Ably). `src/embed.tsx` (`WebPocApp`) is the entry the canvas host
  mounts. (`src/main.tsx` / `index.html` are the old standalone root, now inert.)
- `worker/` — the Hono + `@hono/zod-openapi` API. `worker/index.ts` exports
  `buildApp`, mounted at canvas's edge Worker (ADR-0018). Routes: `/api/auth/*`
  (Better Auth), `/v1/*` (the contract), `/health`, `/doc`, `/ui`.
- `lib/` — the former workspace packages, relative-imported:
  `ai` (the embedder factory), `config` (env + tunables), `contract` (zod-openapi
  schemas shared by SPA + worker), `db` (Drizzle over D1, `migrations/`),
  `realtime` (Ably channel contract).
- `scripts/` — `emit-openapi.ts`.

## How canvas mounts it

Canvas imports this module by **relative path** (no `@cedarpad/web-poc` package):
`../web-poc/src/embed` (`WebPocApp`), `../web-poc/worker/index.ts` (`buildApp`),
`../web-poc/worker/runtime.ts` (`createDbForWorker`). The canvas app lazy-mounts
`WebPocApp` behind its 3rd left-rail button (`packages/canvas/src/App.tsx`); canvas's
**edge Worker** (`packages/canvas/worker/index.ts`) mounts `buildApp` directly for
`/v1/*` + `/api/auth/*` (ADR-0018), building the db per request from its `PLATFORM_DB`
D1 binding — the container/bridge holds no database client at all. In dev that
binding is the SQLite file behind miniflare's local D1; in prod it's the same D1
binding, live since the cutover (#267). Canvas's Vite serves the SPA and proxies
`/v1` + `/api/auth` to the edge Worker, the rest of `/api` to the bridge. Nothing
migrates on boot — `bun run webpoc:db:migrate:local` applies `lib/db/migrations` to
the local D1.

For the full request flow (dev + prod), the `/v1` auth model (session vs
`x-api-key`), remote access, and whether canvas should hold a service key, see
`docs/API_ACCESS.md`.

## Local dev

Run everything from canvas — there is no standalone dev server:

1. `bun install` (repo root).
2. `cp web-poc/.dev.vars.example web-poc/.dev.vars` — local env: `VOYAGE_API_KEY`
   (else a hash fallback), `BETTER_AUTH_SECRET`, optional `ABLY_API_KEY` /
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. The platform data layer is always the
   local D1 — nothing to configure for it.
3. `cd packages/canvas && bun run webpoc:db:migrate:local` — apply
   `lib/db/migrations` to the local D1 (idempotent; re-run after a new migration).
4. `cd packages/canvas && bun run dev` — vite (:4510) + bridge (:4511) + edge
   Worker (:4513), which serves `/v1/*` + `/api/auth/*` off the local D1.

## Schema / migrations

Drizzle owns the schema (`lib/db/schema.ts`) and migrations (`lib/db/migrations`,
config in `drizzle.config.ts`). Generate with `bun run webpoc:db:generate` (from
`packages/canvas`); never hand-edit `.sql` or `meta/_journal.json`, and never roll
back — only forward-fix.

## Search

There is none yet. Embeddings and the exact cosine scan behind them were removed
with the intake pipeline (ADR-0024): `vector_distance_cos` and `vector32()` are
libSQL functions, so both the read and the write path had been dead in production
since the D1 cutover. Search returns on **D1's native FTS5**. What survives is the
embedder factory — `lib/ai/embedder.ts`, selected in `worker/agent.ts`
`createEmbedder` — kept for whatever indexes the corpus next.

## No background work

The `agent_jobs` queue, its `agent_runs` audit trail and the LLM intake pipeline
are gone. A write to the Notebook is one insert; the thinking moves to cedarpad
agents, which reach it over MCP.

## Relationships

- **web-poc → Canvas**: it *is* part of canvas — mounted at the edge and shipped
  inside the single `agent-canvas` Cloudflare instance. Its env (`VOYAGE_API_KEY`,
  `BETTER_AUTH_*`, `WEB_ORIGIN`) rides the canvas worker secrets
  (`packages/infra/environments/production/canvas.ts` `workerSecrets`, all must
  exist in `production/secrets.yaml`, SOPS-encrypted). Deploy is
  `packages/canvas/scripts/deploy.sh` (`zbc apply production canvas`).
- **Standalone deploy: removed.** The old `infra/.../web-poc.ts` target,
  `wrangler.jsonc`, and the `.github/workflows/production.yml` auto-deploy were
  retired in the merge — there is no longer a `cedarpad-web-poc` worker.
- `BETTER_AUTH_URL` / `WEB_ORIGIN` are non-secret vars on the canvas worker
  (`packages/canvas/wrangler.jsonc`), set to the canvas origin (`poc.cedarpad.com`).
