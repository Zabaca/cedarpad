# CLAUDE.md — @cedarpad/canvas

Rules and orientation for AI sessions in this package. Depth: `CONTEXT.md`
(canvas domain model), `docs/notebook/` (Notebook domain + architecture refs,
incl. `CONTEXT.md`, `MIGRATION.md`, `API_ACCESS.md`), `docs/decisions/` (ADRs).

## What this is

ONE application with two surfaces behind ONE Better Auth login:

- **Canvas** — a tldraw canvas with a built-in Claude agent (`src/`, `server/`).
- **Notebook** — the Problem/Solution intelligence app, formerly "web-poc":
  React SPA (`src/notebook/`) + Hono `/v1` API (`server/notebook/`), backed by
  Turso (libSQL) with Voyage embeddings. Shared libs in `lib/`
  (`ai`/`config`/`contract`/`db`/`realtime`).

Both are served by one bridge process (`server/bridge.ts`) and one vite dev
server, shipped as the single `agent-canvas` Cloudflare Worker + container.
Vite is the RUNTIME compiler (the agent authors components live), so the
container runs the dev stack — never introduce a static build (ADR 0001).

## Auth model (post cs_gate)

- **Users**: Better Auth email/password login gates EVERYTHING. The frontend
  gate lives in `src/App.tsx` (`Gate`); the bridge enforces a session cookie on
  all canvas `/api/*` routes (open: `/api/health`, `/api/status`), with a 60s
  in-memory validation cache. Notebook's `/v1/*` gates itself
  (`server/notebook/middleware.ts`: session cookie or `x-api-key`).
- **Signup is disabled in production** (`AUTH_DISABLE_SIGNUP=1` in wrangler
  vars; `VITE_AUTH_DISABLE_SIGNUP` hides the UI). Local dev signup is open.
- **Deploy ops**: `GATE_SECRET` is ONLY the `x-ops-key` header for the worker's
  `/__recycle` + `/__bootlog`. There is no user-facing key or gate cookie.
- **In-stack calls**: agent-authored custom handlers (extension server) call the
  core `/api/canvas` with `x-internal-key: CANVAS_INTERNAL_KEY` (minted per boot
  by `scripts/dev.ts`).

## Hard rules

### Database migrations — Drizzle only (NEVER hand-write SQL)
1. Schema changes in TypeScript in `lib/db/schema.ts`, then
   `bun run notebook:db:generate` (runs `bunx --bun drizzle-kit generate`).
2. Never hand-edit `.sql` under `lib/db/migrations/` or
   `lib/db/migrations/meta/_journal.json`.
3. No rollbacks / no editing past migrations — forward-only.

### Deploys — never without explicit approval
`scripts/deploy.sh` (`zbc apply production canvas`). Do not run it (or any
`zbc apply`) unless the user explicitly asks in this session. Local
dev/build/typecheck are always fine. NOTE: prod signup is disabled — before any
deploy that changes auth, confirm a working prod login exists (lockout risk).

### Secrets
Never commit real secrets. Local dev uses `.dev.vars` (package root,
gitignored). Production secrets live SOPS-encrypted in
`packages/infra/environments/production/secrets.yaml`, pushed as Worker secrets
by the zbc module (`environments/production/canvas.ts` `workerSecrets`).

## Dev / test workflow

- Run everything: `bun run dev` (vite :4510 + bridge :4511 + extension :4512).
  No turso CLI needed — dev uses a local libSQL file (`.notebook-dev.db`),
  migrated on boot. Prod uses remote Turso (migrate via `notebook:db:migrate`
  with TURSO_URL/TURSO_KEY set; deploys do NOT run migrations).
- `bun run typecheck` (one tsconfig for src/server/shared/scripts/lib) and
  `bun run test` (`bun test server src lib` — one runner, bun:test) must stay clean.
- **Contract changes** (`lib/contract`): `bun run notebook:openapi:emit` (writes
  `openapi.json`) then `bun run notebook:gen:api` (regenerates
  `src/notebook/api-types.ts`). Drift test: `server/notebook/openapi.test.ts`.
  Routes register via `.openapi(contract.xRoute, handler)` in
  `server/notebook/index.ts`.

## Where things live

- Canvas shell: `src/` (App/Gate, LeftPanel rail with Canvas | Notebook,
  ChatShape, ComponentShape, sync). Agent-authored zones: `src/canvas-components/`
  + `server/custom/` (everything else is image-only core — ADR 0002).
- Notebook UI: `src/notebook/` (embedded via lazy `NotebookApp`).
- Bridge + agent: `server/` (bridge.ts mounts the notebook Hono app in-process
  and routes `/v1/*` + `/api/auth/*` to it, before canvas `/api/*`).
- Notebook API: `server/notebook/` (`buildApp`), shared libs: `lib/`.
- Notebook scripts: `scripts/notebook/` (migrate/seed/openapi/eval/jobs-worker).
- The original apex monorepo is at `../../../apex` (read-only reference).
