# CLAUDE.md — @cedarpad/web-poc

Rules and orientation for AI sessions working in this package. Read `CONTEXT.md`
(domain + dev workflow), `MIGRATION.md` (history of the apex→web-poc move), and
`docs/README.md` (architecture refs + migration delta) for depth.

## What this is

The Cedarpad Problem/Solution app: a React SPA (`src/`) + Hono API (`worker/`),
backed by Turso (libSQL) with Voyage embeddings. Shared libs in `lib/`
(`ai`/`config`/`contract`/`db`/`realtime`).

**As of 2026-07-01 this is an in-tree module of `@cedarpad/canvas`, not a
package.** It lives at `packages/canvas/web-poc/`, has **no `package.json`/
`exports`** of its own (canvas owns the deps), and canvas imports it by **relative
path** — mounted in-process as the canvas 3rd nav view, shipped inside the single
`agent-canvas` Cloudflare instance. React is **19** (unified with canvas). The
standalone worker + deploy were retired. When changing an entry point —
`src/embed.tsx` (`WebPocApp`), `worker/index.ts` (`buildApp`), `lib/db/index.ts`
(`makeDb`), or the contract — check the canvas consumers: `packages/canvas/src/App.tsx`
and `packages/canvas/server/bridge.ts`. See `CONTEXT.md` → "Embedded in canvas"
and `MIGRATION.md` → "Embedded into canvas".

## Hard rules

### Database migrations — Drizzle only (NEVER hand-write SQL)
1. **Use the generator:** schema changes are made in TypeScript in
   `lib/db/schema.ts`, then `bun run webpoc:db:generate` from `packages/canvas`
   (runs `bunx --bun drizzle-kit generate` — the `--bun` matters so relative `.ts`
   imports resolve).
2. **Never hand-edit** any `.sql` file under `lib/db/migrations/`, and never
   touch `lib/db/migrations/meta/_journal.json`. Drizzle owns these exclusively.
3. **No rollbacks / no editing past migrations.** To undo a schema change, write
   a new forward migration. Never delete a migration to "go back in time."
   - *One historical exception, already done:* before any production deploy the
     migrations were regenerated into a single clean baseline (1024-dim vectors).
     That was a pre-prod reset. Do **not** repeat it once prod data exists — go
     forward-only from here.

### Deploys — never without explicit approval
web-poc ships as part of canvas now: deploying means
`packages/canvas/scripts/deploy.sh` (`zbc apply production canvas`). Do not run it
(or any `zbc apply`) unless the user explicitly asks in this session. Local
dev/build/typecheck are always fine.

### Secrets
Never commit real secrets. Local dev uses `web-poc/.dev.vars` (gitignored).
Production secrets live SOPS-encrypted in `packages/infra/environments/production/
secrets.yaml` and are pushed as Worker secrets by the zbc module — now as
`workerSecrets` in **`canvas.ts`** (web-poc's secrets ride the canvas worker).

## Architecture notes

- **Worker entry**: `worker/index.ts` exports `buildApp` (a Hono `OpenAPIHono`
  factory). It runs **in the canvas bridge process** (`packages/canvas/server/
  bridge.ts`), which injects the db; the bridge routes `/v1/*` and `/api/auth/*`
  to it. (There is no standalone `export default` worker / `run_worker_first` /
  Cloudflare Assets path anymore — canvas's vite serves the SPA and proxies.)
- **Embeddings: Voyage `voyage-3.5-lite`, 1024 dims.** `createEmbedder`
  (`worker/agent.ts`) uses Voyage when `VOYAGE_API_KEY` is set, else a
  deterministic local hash (lexical, offline). Asymmetric `input_type` is
  threaded through `Embedder.embed(text, "document"|"query")`.
- **Embed → store → search is inline & synchronous.** Create embeds
  (`document`) and stores on the row; search embeds (`query`) and runs an exact
  `vector_distance_cos` scan (`lib/db/queries/similar.ts`, no ANN index — see
  `docs/SIMILARITY_SCALING.md`). The core loop needs **no background worker**.
- **`agent_jobs` queue is optional & inert.** It carries LLM
  classification/linking/synthesis, enqueued behind `runAgent`, but nothing
  drains it unless you run `bun run dev:worker`. There is no Cron/`scheduled`
  consumer (removed). To productionize it later: Cron `scheduled` handler,
  Cloudflare Queues, or Workflows — see `MIGRATION.md` → "Async agent jobs".
- **DB client**: the canvas bridge builds **one** `@libsql/client` (node — speaks
  both a local file and remote Turso) and passes it to `makeDb` → `buildApp`. In
  dev that file is miniflare's local D1, which the edge Worker serves `/v1/*` +
  `/api/auth/*` from (ADR-0018; apply migrations with
  `bun run webpoc:db:migrate:local`); in prod it's remote Turso from env.
  (`worker/runtime.ts` `createDbForWorker` is the edge's own path: the D1 binding
  when bound, otherwise workerd's `@libsql/client/web` against Turso.)

## Dev / test workflow

- **No `turso` CLI / daemon needed.** Run the whole stack from canvas:
  `cd packages/canvas && bun run dev` (vite :4510 + bridge :4511 + edge Worker
  :4513). Migrations are explicit: `bun run webpoc:db:migrate:local`.
- **Contract changes** (`lib/contract`): the web client types are NOT automatic.
  From `packages/canvas`: `bun run webpoc:openapi:emit` (writes `openapi.json` from
  the registered routes) then `bun run webpoc:gen:api` (regenerates
  `src/api-types.ts`). A drift test (`worker/openapi.test.ts`) guards this. A route
  must be registered with `.openapi(contract.xRoute, handler)` in `worker/index.ts`.
- `bun run webpoc:typecheck` must stay clean (uses `web-poc/tsconfig.json`). Tests
  are excluded from typecheck; some `*.test.ts` need a DB and aren't wired headless.

## Where things live

- Up-to-date docs: `README.md`, `CONTEXT.md`, `MIGRATION.md`, `docs/`.
- Canvas consumers of this module: `packages/canvas/src/App.tsx` (embed),
  `packages/canvas/server/bridge.ts` (worker + db), `packages/canvas/package.json`
  (deps + `webpoc:*` scripts).
- The original apex monorepo is intact at `../../../../apex` (read-only reference;
  do not modify it).
