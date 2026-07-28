# web-poc — Cedarpad Problem/Solution intelligence (in-tree module of canvas)

A React **SPA** + a **Hono** API backed by the platform D1 (ADR-0018) with Voyage
embeddings. Migrated from the standalone `apex` monorepo (API Worker + Pages SPA + 5
workspace packages) into its own package, then — as of 2026-07-01 — **merged into
`@cedarpad/canvas`** at `packages/canvas/web-poc/`.

**It is no longer a standalone worker or a package.** Canvas's edge Worker serves
its Hono app directly (ADR-0018), canvas's Vite serves the SPA, and prod ships as
one Cloudflare instance. There is no `package.json`/`exports` — canvas imports it
by relative path and owns its dependencies. See "How canvas mounts it" below.

## Layout

- `src/` — the React 19 SPA (Mantine, React Query, zustand, Better Auth client,
  openapi-fetch, Ably). `src/embed.tsx` (`WebPocApp`) is the entry the canvas host
  mounts. (`src/main.tsx` / `index.html` are the old standalone root, now inert.)
- `worker/` — the Hono + `@hono/zod-openapi` API. `worker/index.ts` exports
  `buildApp`, mounted at canvas's edge Worker (ADR-0018). Routes: `/api/auth/*`
  (Better Auth), `/v1/*` (the contract), `/health`, `/doc`, `/ui`.
- `lib/` — the former workspace packages, relative-imported:
  `ai` (AI SDK pipeline), `config` (env + tunables), `contract` (zod-openapi
  schemas shared by SPA + worker), `db` (Drizzle, driver-agnostic over D1/libSQL,
  vectors, `migrations/`), `realtime` (Ably channel contract).
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

## Embeddings & search

Embeddings use **Voyage `voyage-3.5-lite`** (1024-dim) via a REST embedder
(`lib/ai/embedder.ts` `createVoyageEmbedder`, selected in `worker/agent.ts`
`createEmbedder` when `VOYAGE_API_KEY` is set; deterministic local hash as the
offline fallback). They are computed **inline**: at create
(`createObservationRoute`/`createProblemRoute`, `input_type=document`, stored on
the row) and at search (`searchGraphRoute`, `input_type=query`), which runs an
exact cosine scan (`lib/db/queries/similar.ts`, no ANN index). So the core
embed→store→search loop needs **no background worker**.

## Async jobs (optional)

The `agent_jobs` table is still used for the **LLM** agent work (classification /
similarity-linking / synthesis), enqueued behind `runAgent`. It is **inert** —
nothing drains it; the standalone local consumer script was retired with the Turso
cleanup (#268) since it can't reach D1 outside workerd. Re-introducing a production
consumer (Cron `scheduled`, Queues, or Workflows) is documented in `MIGRATION.md` →
"Async agent jobs".

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
