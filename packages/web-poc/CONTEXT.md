# Web POC — Cedarpad app

A single Cloudflare Worker that serves a Vite-built React **SPA** and hosts the
Cedarpad **Hono** API — one codebase, local dev fully local, production on
Cloudflare's edge. Migrated from the standalone `apex` monorepo (API Worker +
Pages SPA + 5 workspace packages), flattened into one deployable package.

## Layout

- `src/` — the React 18 SPA (Mantine, React Query, zustand, Better Auth client,
  openapi-fetch, Ably). Entry `src/main.tsx` / `index.html`.
- `worker/` — the Hono + `@hono/zod-openapi` API (`worker/index.ts` is the
  `export default` app). Routes: `/api/auth/*` (Better Auth), `/v1/*` (the
  contract), `/health`, `/doc`, `/ui`.
- `lib/` — the former workspace packages, now relative-imported:
  `ai` (AI SDK pipeline), `config` (env + tunables), `contract` (zod-openapi
  schemas shared by SPA + worker), `db` (Drizzle + libSQL/Turso, vectors,
  `migrations/`), `realtime` (Ably channel contract).
- `scripts/` — `migrate.ts` (Drizzle migrator), `seed.ts`, `emit-openapi.ts`.

## Language

**SPA**: the Vite-built React client (`src/`). In production it is served as
static **Assets** by the Worker; unmatched routes fall back to `index.html`
(`not_found_handling: single-page-application`). The client uses same-origin
relative API paths (`apiUrl: ""`).

**Worker**: the `workerd` script (`worker/index.ts`). `run_worker_first`
(`/api/*`, `/v1/*`, `/doc`, `/ui`, `/health`) makes those paths hit the Worker
*before* the SPA asset fallback. The DB client is built with
`@libsql/client/web` in `worker/runtime.ts` from `env.TURSO_URL` / `env.TURSO_KEY`.

**Local DB daemon**: `turso dev` (sqld) backing `./.turso-local.db`, served over
HTTP. `workerd` has no filesystem, so local dev points `TURSO_URL` at this
daemon. Started with `bun run dev:db`. (Requires the `turso` CLI installed.)

**Turso**: the managed libSQL database used in production. The Worker code is
identical across environments; only the env differs (`.dev.vars` local vs Worker
secrets in prod).

## Local dev (two terminals)

1. `bun run dev:db` — local sqld daemon (libSQL over HTTP at
   `http://127.0.0.1:${TURSO_DEV_PORT:-8081}`, matching `.dev.vars`).
2. `bun run db:migrate` (once) — apply Drizzle migrations to the daemon;
   optionally `bun run seed`.
3. `bun run dev` — Vite + the Worker in the real `workerd` runtime, SPA HMR.
4. `bun run dev:worker` (optional) — only if you want the LLM agent jobs
   (classification/synthesis) processed. Not needed for embed/search. See
   "Async jobs (optional)" below.

`.dev.vars` (copy from `.dev.vars.example`) holds local env: `TURSO_URL`,
`BETTER_AUTH_SECRET`, and optional `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`ABLY_API_KEY`. Real Turso/provider creds are used only at deploy time (pushed as
Worker secrets by the `cloudflare` zbc module).

## Schema / migrations

Drizzle owns the schema (`lib/db/schema.ts`) and migrations (`lib/db/migrations`,
config in `drizzle.config.ts`). Generate with `bun run db:generate`; never
hand-edit `.sql` or `meta/_journal.json`, and never roll back — only forward-fix.

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
`bun run dev:worker` (`scripts/worker.ts`). Re-introducing a production consumer
(Cron `scheduled`, Queues, or Workflows) is documented in `MIGRATION.md` →
"Async agent jobs".

## Relationships

- **Web POC → Infra**: deployed by the `cloudflare` module instance
  (`packages/infra/environments/production/web-poc.ts`), which builds, runs
  `wrangler deploy`, and pushes `TURSO_URL`, `TURSO_KEY`, `ABLY_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BETTER_AUTH_SECRET` as Worker secrets
  (all must exist in `production/secrets.yaml`, SOPS-encrypted).
  A merge to `main` touching `packages/web-poc/**` or `packages/infra/**`
  auto-deploys via `.github/workflows/production.yml` (`zbc apply production
  web-poc`); it decrypts `secrets.yaml` with the `SOPS_AGE_KEY` CI key.
- `BETTER_AUTH_URL` should be set to the deployed Worker origin (wrangler var or
  secret) once the URL is known.
