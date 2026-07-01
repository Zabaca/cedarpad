# web-poc — Cedarpad Problem/Solution intelligence (in-tree module of canvas)

A React **SPA** + a **Hono** API backed by Turso (libSQL) with Voyage embeddings.
Migrated from the standalone `apex` monorepo (API Worker + Pages SPA + 5 workspace
packages) into its own package, then — as of 2026-07-01 — **merged into
`@cedarpad/canvas`** at `packages/canvas/web-poc/`.

**It is no longer a standalone worker or a package.** Canvas mounts it in-process
as its 3rd nav view (one React 19 tree, no iframe): the canvas bridge serves the
Hono app, canvas's Vite serves the SPA, and prod ships as one Cloudflare instance.
There is no `package.json`/`exports` — canvas imports it by relative path and owns
its dependencies. See "How canvas mounts it" below.

## Layout

- `src/` — the React 19 SPA (Mantine, React Query, zustand, Better Auth client,
  openapi-fetch, Ably). `src/embed.tsx` (`WebPocApp`) is the entry the canvas host
  mounts. (`src/main.tsx` / `index.html` are the old standalone root, now inert.)
- `worker/` — the Hono + `@hono/zod-openapi` API. `worker/index.ts` exports
  `buildApp` (run inside the canvas bridge). Routes: `/api/auth/*` (Better Auth),
  `/v1/*` (the contract), `/health`, `/doc`, `/ui`.
- `lib/` — the former workspace packages, relative-imported:
  `ai` (AI SDK pipeline), `config` (env + tunables), `contract` (zod-openapi
  schemas shared by SPA + worker), `db` (Drizzle + libSQL/Turso, vectors,
  `migrations/`), `realtime` (Ably channel contract).
- `scripts/` — `migrate.ts` (Drizzle migrator), `seed.ts`, `emit-openapi.ts`,
  `worker.ts` (optional agent-jobs consumer).

## How canvas mounts it

Canvas imports this module by **relative path** (no `@cedarpad/web-poc` package):
`../web-poc/src/embed` (`WebPocApp`), `../web-poc/worker/index.ts` (`buildApp`),
`../web-poc/lib/db/index.ts` (`makeDb`). The canvas app lazy-mounts `WebPocApp`
behind its 3rd left-rail button (`packages/canvas/src/App.tsx`); the canvas
**bridge** (`packages/canvas/server/bridge.ts`) runs `buildApp` in-process for
`/v1/*` + `/api/auth/*`, building **one** `@libsql/client` (node) it injects via
`makeDb` — a local `packages/canvas/.web-poc-dev.db` file in dev (migrations run on
boot from `lib/db/migrations`, reads `web-poc/.dev.vars`), remote Turso in prod.
The node libSQL client speaks both file and remote, so **no `turso dev` daemon is
needed**; canvas's Vite serves the SPA and proxies `/v1` + `/api` to the bridge.

## Local dev

Run everything from canvas — there is no standalone dev server:

1. `bun install` (repo root).
2. `cp web-poc/.dev.vars.example web-poc/.dev.vars` — local env: `VOYAGE_API_KEY`
   (else a hash fallback), `BETTER_AUTH_SECRET`, optional `ABLY_API_KEY` /
   `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. (`TURSO_URL` is left unset in dev so the
   bridge uses the local libSQL file.)
3. `cd packages/canvas && bun run dev` — vite (:4510) + bridge (:4511); web-poc
   mounts in-process, migrations run on boot.
4. Optional LLM agent jobs: `cd packages/canvas/web-poc && bun scripts/worker.ts`
   (not needed for embed/search — see "Async jobs (optional)" below).

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
similarity-linking / synthesis), enqueued behind `runAgent`. It is **inert by
default** — nothing drains it unless you run the optional consumer
`bun scripts/worker.ts` (from `web-poc/`). Re-introducing a production consumer
(Cron `scheduled`, Queues, or Workflows) is documented in `MIGRATION.md` →
"Async agent jobs".

## Relationships

- **web-poc → Canvas**: it *is* part of canvas — mounted in-process and shipped
  inside the single `agent-canvas` Cloudflare instance. Its env (`TURSO_*`,
  `VOYAGE_API_KEY`, `BETTER_AUTH_*`, `WEB_ORIGIN`) rides the canvas worker secrets
  (`packages/infra/environments/production/canvas.ts` `workerSecrets`, all must
  exist in `production/secrets.yaml`, SOPS-encrypted). Deploy is
  `packages/canvas/scripts/deploy.sh` (`zbc apply production canvas`).
- **Standalone deploy: removed.** The old `infra/.../web-poc.ts` target,
  `wrangler.jsonc`, and the `.github/workflows/production.yml` auto-deploy were
  retired in the merge — there is no longer a `cedarpad-web-poc` worker.
- `BETTER_AUTH_URL` / `WEB_ORIGIN` are non-secret vars on the canvas worker
  (`packages/canvas/wrangler.jsonc`), set to the canvas origin (`poc.cedarpad.com`).
