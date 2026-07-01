# apex → web-poc migration

Record of moving the standalone `apex` monorepo into this package as a single
Cloudflare Worker + Turso deployment. Source (`../../../apex`) was **copied, not
moved** — it remains intact and untouched.

Date: 2026-06-29.

## What changed

apex shipped as **two** Cloudflare targets (a `cedarpad-api` Hono Worker + a
`cedarpad-web` Pages SPA) across a bun/turbo monorepo with 5 workspace packages.
This package collapses that into **one** Worker that serves the SPA *and* the
API, backed by Turso.

### File moves (copy)

| From (apex) | To (web-poc) |
|---|---|
| `apps/web/src/**`, `apps/web/index.html` | `src/**`, `index.html` |
| `apps/api/src/**` | `worker/**` (entry: `worker/index.ts`, `export default app`) |
| `packages/{ai,config,contract,db,realtime}/src/**` | `lib/{ai,config,contract,db,realtime}/**` |
| `packages/db/migrations/**` | `lib/db/migrations/**` (verbatim, Drizzle-owned) |
| `apps/api/scripts/{seed,emit-openapi,eval}.ts`, `packages/db/src/migrate.ts` | `scripts/**` |
| `openapi.json` | `openapi.json` |

### Code edits

- **Imports**: every `@cedarpad/{ai,config,contract,db,realtime}` workspace
  import rewritten to a relative `lib/*` path (`.js` extensions preserved for
  bundler/Bun resolution). Scripts' `../src/*` → `../worker/*`.
- **Env-var reconciliation** to cedarpad/infra convention
  `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` → **`TURSO_URL`/`TURSO_KEY`** in
  `worker/runtime.ts` (`createDbForWorker`, builds the `@libsql/client/web`
  client), `worker/context.ts` (`Bindings`), `lib/config/env.ts` (`envSchema`),
  `scripts/migrate.ts`, `scripts/seed.ts`, `drizzle.config.ts`.
- **Same-origin client**: `src/config.ts` `apiUrl` default `"http://localhost:8787"`
  → `""` (SPA and API now share the Worker origin; `credentials: "include"`
  still works).
- **Local-dev DB defaults**: `scripts/migrate.ts` / `scripts/seed.ts` /
  `drizzle.config.ts` default to the local `turso dev` daemon
  (`http://127.0.0.1:8081`) instead of `file:local.db` (workerd has no fs).
  `migrate.ts` migrations folder → `./lib/db/migrations`.

### New / rewritten config

- **`package.json`** — merged deps of apps/web + apps/api + the 5 packages.
  React pinned to **18.3.1** (the SPA's version), overriding the POC's React 19.
  Build toolchain kept at the POC's proven Cloudflare versions (vite 8,
  `@cloudflare/vite-plugin` 1.42.2, wrangler 4.104.0). `db:generate` runs via
  `bunx --bun drizzle-kit` so Bun's loader resolves the relative `.ts` schema.
- **`wrangler.jsonc`** — single worker; `run_worker_first` extended from
  `["/api/*"]` to `["/api/*","/v1/*","/doc","/ui","/health"]` (apex's real route
  prefixes); SPA asset fallback via `single-page-application`.
- **`vite.config.ts`** — `react()` + `cloudflare()` plugins; apex's API proxy
  dropped (worker runs in-process via the plugin); apex's `manualChunks`
  splitting and worktree-safe dev port preserved.
- **`tsconfig.json`** — `Bundler` resolution; lib `DOM` + `@cloudflare/workers-types`
  + `vite/client`; `declaration:false` (portability); tests excluded from
  typecheck.
- **`drizzle.config.ts`**, **`.dev.vars(.example)`** — created.
- **`CONTEXT.md`** — rewritten to describe the migrated app.

### Infra

- `packages/infra/environments/production/web-poc.ts` — `workerSecrets` extended
  from `['TURSO_URL','TURSO_KEY']` to also include `ABLY_API_KEY`,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BETTER_AUTH_SECRET`.

## Verification results (all local, nothing deployed)

| Check | Command | Result |
|---|---|---|
| Install | `bun install` (cedarpad root) | ✅ 1662 packages |
| Typecheck | `bun run typecheck` | ✅ clean (after `declaration:false`) |
| Build | `bun run build` | ✅ worker `index.js` + SPA (mantine/query/auth/react/GraphView/ably code-split) |
| Schema drift | `bun run db:generate` | ✅ "No schema changes, nothing to migrate" |
| Worker smoke (workerd) | `bun run dev` + curl | ✅ `/` → 200 SPA · `/health` → `{"ok":true,"reasoner":"heuristic"}` · `/doc` → OpenAPI JSON |
| Deploy **dry run** | `wrangler deploy --dry-run --config dist/cedarpad_web_poc/wrangler.json` | ✅ see below |

### Dry-run output (no upload, no auth — `--dry-run: exiting now`)

```
⛅️ wrangler 4.104.0
Attaching additional modules:
  assets/auth-CQ9NSK-c.js              esm  1982.23 KiB
  assets/rolldown-runtime-B-1-B7_t.js  esm     1.37 KiB
  Total (2 modules)                         1983.61 KiB
✨ Read 13 files from the assets directory .../dist/client
Total Upload: 3445.86 KiB / gzip: 674.83 KiB
No bindings found.
--dry-run: exiting now.
```

The plugin-generated `dist/cedarpad_web_poc/wrangler.json` correctly carries the
merged `run_worker_first` prefixes and `assets.directory: ../client`.
Compressed upload (~675 KiB) is well within Workers' size limit. `No bindings
found` is expected — runtime secrets are pushed via `wrangler secret put` by the
zbc module, not declared as config bindings.

## Embeddings: Voyage + inline flow

A follow-up change after the initial migration:

- **Provider → Voyage `voyage-3.5-lite`** (`lib/ai/embedder.ts`
  `createVoyageEmbedder`, a workerd-native REST client; selected in
  `worker/agent.ts` `createEmbedder` when `VOYAGE_API_KEY` is set, else the
  deterministic local hash). Config in `lib/config/configuration.ts`:
  `embeddingProvider: "voyage"`, `embeddingModel: "voyage-3.5-lite"`,
  `EMBEDDING_DIMENSIONS: 1024` (Voyage default; Matryoshka 256/512/1024/2048).
  `input_type` is threaded through `Embedder.embed(text, "document"|"query")` so
  stored records and search queries are encoded asymmetrically.
- **Dimension 1536 → 1024** → since nothing is deployed, the Drizzle migrations
  were **regenerated as a single clean baseline** (`bun run db:generate` after
  clearing `lib/db/migrations/`) → one file `0000_*.sql` at `F32_BLOB(1024)`.
- **Inline embedding (replaces the async embed step)**:
  - *Create* (`createObservationRoute` / `createProblemRoute`): embed the record
    (`input_type=document`) and store `embedding` + `embeddingModel` in the same
    insert — searchable immediately, no worker. Best-effort: on embed failure the
    row is still created with a NULL embedding.
  - *Search* (`searchGraphRoute`, already inline; graph tools): embed the query
    (`input_type=query`) → `searchGraph` exact cosine scan.
- **Cron removed**: `worker/index.ts` reverted to `export default app`;
  `wrangler.jsonc` `triggers` removed. (See "Async agent jobs" below.)
- **Secrets**: `VOYAGE_API_KEY` added to `lib/config/env.ts`,
  `worker/context.ts` `Bindings`, infra `web-poc.ts` `workerSecrets`, and
  `.dev.vars.example`.

### Observation input API (verified, no change needed)

`POST /v1/observations` (`createObservationRoute`) already accepts external
input, secured by `authMiddleware` via the `x-api-key` header. Create a key in
the web UI (Settings → API Keys, `ApiKeysView` → Better Auth `apiKey` plugin),
then:

```bash
curl -X POST https://<worker-origin>/v1/observations \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"title":"...","body":"..."}'
```

## Not yet verified / remaining

- **DB-backed local e2e** (signup, `/v1/*`) was not run: the `turso` CLI was not
  visible on the agent shell's PATH. To run it:
  `bun run dev:db` → `TURSO_URL=http://127.0.0.1:8081 bun run db:migrate` →
  `bun run dev`, then exercise auth/`/v1` routes.
- **Secrets**: ensure `VOYAGE_API_KEY` (embeddings) and `BETTER_AUTH_SECRET` are
  in `packages/infra/environments/production/secrets.yaml` (SOPS-encrypted);
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` are only needed if you run the optional
  LLM agent-jobs consumer. `TURSO_URL`/`TURSO_KEY`/`ABLY_API_KEY` already present.
- **Embedding consistency**: vectors are model-specific. If you change the
  embedding model/dimension after data exists, re-embed all rows (each row stores
  its `embedding_model`) — mixed models won't compare correctly.
- **`BETTER_AUTH_URL`**: set to the deployed Worker origin (wrangler var or
  secret) once known.
- (See "Async agent jobs" below for the queue-draining design.)

## Async agent jobs (job queue)

Intake is decoupled from AI work via the `agent_jobs` table. The HTTP path only
**enqueues** (`enqueueAgentJob` in `worker/index.ts`) and returns immediately;
a **consumer** drains the table (`drainAgentJobs` / `processNextJob` in
`worker/worker.ts`) and runs the pipelines (embed/classify/synthesize). The two
halves meet only through the table.

### Current state — embedding is inline, the queue is optional

Option A (Cron Trigger + `scheduled`) was **implemented then reverted** (see
"Embeddings: Voyage + inline flow" above). Embeddings — the part that powers
similarity search — are now computed **synchronously at create and search
time**, so the core embed→store→search loop needs **no background consumer at
all**. `worker/index.ts` is back to a plain `export default app`; the cron
trigger is removed from `wrangler.jsonc`.

The `agent_jobs` queue still exists for the **LLM** work (classification /
similarity-linking / synthesis) and is still enqueued behind `runAgent`, but it
is **inert by default** — nothing drains it until you run the optional consumer
`bun run dev:worker` (`scripts/worker.ts`). It accumulates a few dormant rows
otherwise; harmless. Re-introduce Option A (or B/C/D below) only when you start
using the LLM agent.

### Scaling options for later (not implemented)

- **B. Low-latency kick** — after `enqueueAgentJob`, also
  `ctx.waitUntil(drainAgentJobs(db, env, { max: 1 }))` so the common case
  processes in the same request without waiting for the next cron tick. Keep the
  cron as the safety net. Watch Worker CPU limits (AI calls are I/O-bound, so
  usually OK). Requires `ExecutionContext` access in the route (Hono
  `c.executionCtx`).
- **C. Cloudflare Queues** — replace table-polling with a real queue binding +
  `queue()` consumer handler. Per-message retries, dead-letter queues, batching,
  and backpressure for free; scales horizontally. More infra (queue binding,
  producer publishes to the queue instead of the table).
- **D. Cloudflare Workflows** — durable, multi-step orchestration with built-in
  retries/checkpoints. Best if a single job becomes a multi-stage pipeline that
  must survive failures mid-run. Heaviest option.

Migration path: A → B is additive (keep cron, add the kick). A/B → C/D is a
producer+consumer rewrite but the `drainAgentJobs`/`processNextJob` job logic is
reusable as the queue/workflow body.

## Embedded into canvas (2026-07-01)

A second, larger integration: web-poc was mounted **into `@cedarpad/canvas`** so
the repo ships as one Cloudflare instance, while remaining standalone-capable.
Two commits:

### `e8407be` — embed as a 3rd nav view (in-process)

- **React 18 → 19**: unified across canvas + web-poc (this reverses the
  `18.3.1` pin recorded above under "New / rewritten config"). Both apps now
  share one React 19 tree — no iframe.
- **New embed entry**: `src/embed.tsx` exports `WebPocApp` — everything
  `main.tsx` does (Mantine + Notifications + React Query providers, global CSS)
  **except** `createRoot`, so the canvas host renders it into its own tree.
- **`package.json` `exports`** added so canvas can import the three seams:
  `./embed` → `src/embed.tsx`, `./worker` → `worker/index.ts` (`buildApp`),
  `./db` → `lib/db/index.ts` (`makeDb`).
- **Backend mount**: the canvas bridge (`packages/canvas/server/bridge.ts`) runs
  `buildApp` in-process for `/v1/*` + `/api/auth/*`, builds **one**
  `@libsql/client` (node — speaks both local file and remote Turso) and injects
  it into `buildApp` (bypassing the workerd `@libsql/client/web` path), reads
  this package's `.dev.vars`, and runs `lib/db/migrations` on boot in dev.
- **Frontend**: canvas lazy-imports `WebPocApp` behind a 3rd left-rail button
  (`packages/canvas/src/App.tsx` + `LeftPanel.tsx`); Mantine's fixed AppShell is
  contained to the frame; canvas Vite proxies `/v1` + `/api` to the bridge.

### `12cdd54` — bake into the canvas container (one instance)

- **Single deploy**: the `agent-canvas` Worker + container now serves both apps.
  `packages/canvas/wrangler.jsonc` sets the container build context to the repo
  root so the image can `COPY` the workspace; `Dockerfile` bakes the root
  manifest + `packages/{canvas,web-poc,infra}` and `bun install` links
  `@cedarpad/web-poc`; `worker/index.ts` forwards web-poc's env (`TURSO_*`,
  `VOYAGE_API_KEY`, `BETTER_AUTH_*`, `WEB_ORIGIN`) into the container and writes
  `.env` into the canvas package (the bridge's cwd).
- **Secrets**: web-poc's secrets were added to `infra/.../canvas.ts`
  `workerSecrets` (must exist in `secrets.yaml`).
- **Status**: `12cdd54` is UNVERIFIED locally (no Docker/deploy in that session).

### Directory merge — nested into canvas, standalone retired (2026-07-01)

The workspace-package indirection (`@cedarpad/web-poc` + its `exports`) was then
removed, folding this into canvas as a plain in-tree module.

- **Moved**: `packages/web-poc/` → `packages/canvas/web-poc/` (git-tracked rename;
  `src/`, `worker/`, `lib/`, `scripts/`, `docs/`, migrations, `.dev.vars` all
  preserved). It is **not** a bun workspace member (workspaces glob is
  `packages/*`).
- **Dropped the package**: deleted `web-poc/package.json` (name + `exports`) and
  `web-poc/node_modules`. Canvas now imports by **relative path** —
  `../web-poc/src/embed`, `../web-poc/worker/index.ts`, `../web-poc/lib/db/index.ts`
  — replacing `@cedarpad/web-poc/{embed,worker,db}` in `App.tsx` + `bridge.ts`.
  The bridge's `.dev.vars` / migrations paths went `../../web-poc/...` →
  `../web-poc/...`.
- **Deps folded into canvas** (`packages/canvas/package.json`): all of web-poc's
  runtime deps (Mantine, React Query, `@xyflow/react`, hono + `@hono/*`,
  better-auth + `@better-auth/api-key`, `ai` + `@ai-sdk/*`, ably, zustand,
  openapi-fetch, …) + dev tooling (`drizzle-kit`, `openapi-typescript`, `vitest`).
  Removed the `@cedarpad/web-poc` workspace dependency.
- **Tooling** moved to `webpoc:*` scripts on canvas (`webpoc:typecheck`,
  `webpoc:db:generate`, `webpoc:db:migrate`, `webpoc:seed`, `webpoc:openapi:emit`,
  `webpoc:gen:api`, `webpoc:test`) — each does `cd web-poc && <tool>`.
  `web-poc/tsconfig.json` kept (extends `../../../tsconfig.json` now); its dead
  standalone `vite.config.ts` was deleted and dropped from `include`.
- **Standalone deploy retired**: deleted `web-poc/wrangler.jsonc`,
  `infra/environments/production/web-poc.ts`, and `.github/workflows/production.yml`
  (its only job deployed the now-gone `cedarpad-web-poc` worker). web-poc ships
  solely inside the `agent-canvas` container; the `COPY packages/web-poc` line was
  removed from the canvas `Dockerfile` (web-poc is copied with `packages/canvas`).
  `src/main.tsx` + `index.html` (the old SPA root) and `worker/runtime.ts`
  (`createDbForWorker`) remain in-tree but are now inert.
- **Verified** (local): canvas `bun run typecheck` ✅, `bun run build` ✅ (embed +
  GraphView chunks unchanged), `bun run webpoc:typecheck` ✅, bridge bundles under
  bun (1214 modules resolve) ✅, `bun run webpoc:db:generate` → "No schema changes"
  ✅. Not run: the live dev stack + a container deploy.
