# Notebook — Cedarpad Problem/Solution intelligence (a surface of canvas)

A React **SPA** + a **Hono** API backed by Turso (libSQL) with Voyage embeddings.
Migrated from the standalone `apex` monorepo, embedded into `@cedarpad/canvas`
(2026-07-01, as "web-poc"), then **dissolved into the canvas package and renamed
Notebook** (2026-07, `integration` branch) — no subdirectory app remains.

**It is one of the two surfaces of the canvas app**, behind the same Better Auth
login (the host `src/App.tsx` gates; see canvas `CONTEXT.md`). The canvas bridge
serves the Hono API in-process, canvas's Vite serves the SPA, and prod ships as
one Cloudflare instance.

## Layout (inside packages/canvas)

- `src/notebook/` — the React 19 SPA (Mantine, React Query, zustand, Better Auth
  client, openapi-fetch, Ably). `src/notebook/App.tsx` exports `NotebookApp`,
  the authenticated shell the host lazy-mounts behind the Notebook rail button.
- `server/notebook/` — the Hono + `@hono/zod-openapi` API. `index.ts` exports
  `buildApp` (run inside the canvas bridge). Routes: `/api/auth/*` (Better
  Auth), `/v1/*` (the contract), `/health`, `/doc`, `/ui`.
- `lib/` — shared libs, relative-imported: `ai` (AI SDK pipeline), `config`
  (env + tunables), `contract` (zod-openapi schemas shared by SPA + API), `db`
  (Drizzle + libSQL/Turso, vectors, `migrations/`), `realtime` (Ably contract).
- `scripts/notebook/` — `migrate.ts` (Drizzle migrator), `seed.ts`,
  `emit-openapi.ts`, `worker.ts` (optional agent-jobs consumer), `eval.ts`.

## How canvas mounts it

The host lazy-mounts `NotebookApp` (`import('./notebook/App')` in
`packages/canvas/src/App.tsx`); the canvas **bridge**
(`packages/canvas/server/bridge.ts`) runs `buildApp` in-process for `/v1/*` +
`/api/auth/*`, building **one** `@libsql/client` (node) it injects via `makeDb`
(`lib/db/index.ts`) — a local `packages/canvas/.notebook-dev.db` file in dev
(migrations run on boot from `lib/db/migrations`, env from `.dev.vars` at the
package root), remote Turso in prod. The node libSQL client speaks both file and
remote, so **no `turso dev` daemon is needed**; canvas's Vite serves the SPA and
proxies `/v1` + `/api` to the bridge.

For the full request flow (dev + prod), the `/v1` auth model (session vs
`x-api-key`), remote access, and whether canvas should hold a service key, see
`API_ACCESS.md` (this directory).

## Local dev

Run everything from canvas — there is no standalone dev server:

1. `bun install` (repo root).
2. `cp .dev.vars.example .dev.vars` (in `packages/canvas`) — local env:
   `VOYAGE_API_KEY` (else a hash fallback), `BETTER_AUTH_SECRET`, optional
   `ABLY_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`. (`TURSO_URL` is left
   unset in dev so the bridge uses the local libSQL file.)
3. `cd packages/canvas && bun run dev` — vite (:4510) + bridge (:4511); the
   notebook API mounts in-process, migrations run on boot. Sign up on the login
   screen (local signup is open; prod is sign-in-only).
4. Optional LLM agent jobs: `bun scripts/notebook/worker.ts` (not needed for
   embed/search — see "Async jobs (optional)" below).

## Schema / migrations

Drizzle owns the schema (`lib/db/schema.ts`) and migrations (`lib/db/migrations`,
config in `drizzle.config.ts` at the package root). Generate with
`bun run notebook:db:generate` (from `packages/canvas`); never hand-edit `.sql`
or `meta/_journal.json`, and never roll back — only forward-fix.

## Embeddings & search

Embeddings use **Voyage `voyage-3.5-lite`** (1024-dim) via a REST embedder
(`lib/ai/embedder.ts` `createVoyageEmbedder`, selected in
`server/notebook/agent.ts` `createEmbedder` when `VOYAGE_API_KEY` is set;
deterministic local hash as the offline fallback). They are computed **inline**:
at create (`createObservationRoute`/`createProblemRoute`, `input_type=document`,
stored on the row) and at search (`searchGraphRoute`, `input_type=query`), which
runs an exact cosine scan (`lib/db/queries/similar.ts`, no ANN index). So the
core embed→store→search loop needs **no background worker**.

## Async jobs (optional)

The `agent_jobs` table is still used for the **LLM** agent work (classification /
similarity-linking / synthesis), enqueued behind `runAgent`. It is **inert by
default** — nothing drains it unless you run the optional consumer
`bun scripts/notebook/worker.ts`. Re-introducing a production consumer (Cron
`scheduled`, Queues, or Workflows) is documented in `MIGRATION.md` →
"Async agent jobs".

## Relationships

- **Notebook → Canvas**: it *is* part of the canvas package — mounted in-process
  and shipped inside the single `agent-canvas` Cloudflare instance. Its env
  (`TURSO_*`, `VOYAGE_API_KEY`, `BETTER_AUTH_*`, `WEB_ORIGIN`) rides the canvas
  worker secrets (`packages/infra/environments/production/canvas.ts`
  `workerSecrets`, all must exist in `production/secrets.yaml`, SOPS-encrypted).
  Deploy is `packages/canvas/scripts/deploy.sh` (`zbc apply production canvas`).
- `BETTER_AUTH_URL` / `WEB_ORIGIN` / `AUTH_DISABLE_SIGNUP` are non-secret vars on
  the canvas worker (`packages/canvas/wrangler.jsonc`), origins set to
  `poc.cedarpad.com`.
