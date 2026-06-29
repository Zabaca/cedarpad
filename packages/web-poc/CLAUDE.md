# CLAUDE.md — @cedarpad/web-poc

Rules and orientation for AI sessions working in this package. Read `CONTEXT.md`
(domain + dev workflow), `MIGRATION.md` (history of the apex→web-poc move), and
`docs/README.md` (architecture refs + migration delta) for depth.

## What this is

A single Cloudflare Worker serving a React SPA (`src/`) + Hono API (`worker/`),
backed by Turso (libSQL) with Voyage embeddings. Shared libs in `lib/`
(`ai`/`config`/`contract`/`db`/`realtime`). Deployed by the zbc cloudflare module
(`packages/infra/environments/production/web-poc.ts`). It is itself a member of
the cedarpad bun workspace (`packages/*`).

## Hard rules

### Database migrations — Drizzle only (NEVER hand-write SQL)
1. **Use the generator:** schema changes are made in TypeScript in
   `lib/db/schema.ts`, then `bun run db:generate` (runs `bunx --bun drizzle-kit
   generate` — the `--bun` matters so relative `.ts` imports resolve).
2. **Never hand-edit** any `.sql` file under `lib/db/migrations/`, and never
   touch `lib/db/migrations/meta/_journal.json`. Drizzle owns these exclusively.
3. **No rollbacks / no editing past migrations.** To undo a schema change, write
   a new forward migration. Never delete a migration to "go back in time."
   - *One historical exception, already done:* before any production deploy the
     migrations were regenerated into a single clean baseline (1024-dim vectors).
     That was a pre-prod reset. Do **not** repeat it once prod data exists — go
     forward-only from here.

### Deploys — never without explicit approval
Do not run `wrangler deploy` (or `zbc apply`) unless the user explicitly asks in
this session. `wrangler deploy --dry-run` (bundles only, no upload/auth) is fine
for validation. Local dev/build are always fine.

### Secrets
Never commit real secrets. Local dev uses `.dev.vars` (gitignored). Production
secrets live SOPS-encrypted in `packages/infra/environments/production/
secrets.yaml` and are pushed as Worker secrets by the zbc module
(`workerSecrets` in `web-poc.ts`).

## Architecture notes

- **One worker entry**: `worker/index.ts` is `export default app` (a Hono
  `OpenAPIHono`). The SPA is served by Cloudflare Assets; `run_worker_first`
  (`wrangler.jsonc`) routes `/api/*`,`/v1/*`,`/doc`,`/ui`,`/health` to the worker.
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
- **DB client**: workerd uses `@libsql/client/web` via
  `createDbForWorker(env)` (`worker/runtime.ts`), reading `TURSO_URL`/`TURSO_KEY`.

## Dev / test workflow

- Requires the `turso` CLI for the local libSQL daemon (workerd has no fs).
- `bun run dev:db` (daemon :8081) → `bun run db:migrate` (once) → `bun run dev`.
- **Contract changes** (`lib/contract`): the web client types are NOT automatic.
  Run `bun run openapi:emit` (writes `openapi.json` from the registered routes)
  then `bun run gen:api` (regenerates `src/api-types.ts`). A drift test
  (`worker/openapi.test.ts`) guards this. A route must be registered with
  `.openapi(contract.xRoute, handler)` in `worker/index.ts` to appear.
- `bun run typecheck` must stay clean. Tests are excluded from typecheck; some
  `*.test.ts` need a DB and aren't wired to run headless.
- HMR is real: editing `worker/**` or `src/**` hot-reloads via
  `@cloudflare/vite-plugin` — no manual restart (unlike apex's old bun
  dev-server).

## Where things live

- Up-to-date docs: `README.md`, `CONTEXT.md`, `MIGRATION.md`, `docs/`.
- The original apex monorepo is intact at `../../../apex` (read-only reference;
  do not modify it).
- Project memories for this folder are under the Claude project dir for
  `cedarpad/packages/web-poc` (replicated/adapted from apex).
