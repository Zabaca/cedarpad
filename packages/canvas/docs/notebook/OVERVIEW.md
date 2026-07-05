> **Historical snapshot.** This is the module README from when Notebook lived at
> `packages/canvas/web-poc/` (pre-dissolution). Paths and names below are stale —
> current state: `CONTEXT.md` (this directory) and the canvas `CLAUDE.md` /
> `README.md`. Kept for the migration record alongside `MIGRATION.md`.

# web-poc (in-tree module of `@cedarpad/canvas`)

The Cedarpad Problem/Solution intelligence app — a React SPA + a Hono API backed
by **Turso** (libSQL) with **Voyage** embeddings for semantic search. Originally
migrated from the apex monorepo into its own package; **as of 2026-07-01 it lives
inside `@cedarpad/canvas`** at `packages/canvas/web-poc/` and is mounted in-process
as the canvas app's 3rd left-rail nav view (one React 19 tree, no iframe). The
whole repo ships as a **single Cloudflare instance** (the `agent-canvas`
container).

> **No longer a standalone package.** It has no `package.json`/`exports` of its
> own — canvas imports it by relative path, owns its dependencies, and is the only
> way it builds/deploys. The standalone Cloudflare Worker (its own
> `wrangler.jsonc` + `infra/.../web-poc.ts` deploy target) was **retired** in the
> merge. See [Running it](#running-it) and `MIGRATION.md` → "Embedded into canvas".

## Stack

- **SPA** (`src/`) — React 19, Mantine, React Query, zustand, Better Auth client,
  openapi-fetch, Ably. Mounted into the canvas React tree via `src/embed.tsx`
  (`WebPocApp`). (`src/main.tsx` + `index.html` are the old standalone root, now
  inert.)
- **Worker** (`worker/`) — Hono + `@hono/zod-openapi`. Routes: `/api/auth/*`
  (Better Auth), `/v1/*` (the contract), `/health`, `/doc`, `/ui`. `buildApp` runs
  inside the canvas bridge process (not as a standalone `export default` worker).
- **Libraries** (`lib/`) — `ai` (embeddings + optional LLM agent), `config`
  (config-as-code + env), `contract` (zod-openapi schemas shared by SPA+worker),
  `db` (Drizzle + libSQL/Turso, F32_BLOB vectors, `migrations/`), `realtime`
  (Ably channel contract).
- **DB** — Turso/libSQL. Embeddings: Voyage `voyage-3.5-lite` (1024-dim), stored
  as `F32_BLOB(1024)`; similarity = exact `vector_distance_cos` scan (no ANN).

## How it works (embed → store → search)

- **Create** an observation/problem → embed inline via Voyage
  (`input_type=document`) → stored on the row in the same insert (searchable
  immediately).
- **Search** (`GET /v1/graph/search`, web or API) → embed the query
  (`input_type=query`) → exact cosine scan over stored vectors.
- No background worker is needed for this loop. The `agent_jobs` queue (LLM
  classification/linking/synthesis) is **optional and inert** unless you run the
  consumer (`cd packages/canvas/web-poc && bun scripts/worker.ts`).

## Running it

You run web-poc **through canvas** — there is no standalone dev server anymore.

```bash
bun install                           # from the cedarpad repo root
cp packages/canvas/web-poc/.dev.vars.example packages/canvas/web-poc/.dev.vars
                                      # fill VOYAGE_API_KEY (else a local hash fallback)
cd packages/canvas && bun run dev     # vite (:4510) + bridge (:4511); web-poc mounts in-process
```

Open `localhost:4510` and click the 3rd left-rail button. In dev the bridge uses a
local libSQL **file** (`packages/canvas/.web-poc-dev.db`) and runs
`web-poc/lib/db/migrations` on boot — **no `turso` CLI / daemon needed** (the node
`@libsql/client` speaks both file and remote). Tooling scripts are namespaced on
the canvas package: `bun run webpoc:db:generate`, `webpoc:db:migrate`,
`webpoc:seed`, `webpoc:openapi:emit`, `webpoc:gen:api`, `webpoc:typecheck`,
`webpoc:test`.

## How canvas mounts it

`@cedarpad/canvas` imports this module by **relative path** (no `@cedarpad/web-poc`
package, no `exports` map) at three seams:

| Import from canvas | Path | Purpose |
|---|---|---|
| `../web-poc/src/embed` (`WebPocApp`) | `packages/canvas/src/App.tsx` | the SPA — everything `main.tsx` does except `createRoot`; lazy-imported behind the 3rd rail button |
| `../web-poc/worker/index.ts` (`buildApp`) | `packages/canvas/server/bridge.ts` | the Hono app (`/v1` + Better Auth `/api/auth`), run inside the bridge process |
| `../web-poc/lib/db/index.ts` (`makeDb`) | `packages/canvas/server/bridge.ts` | the libSQL db the bridge builds once and injects into `buildApp` |

- **Frontend**: the canvas Vite build lazy-loads `WebPocApp`; `/v1` and `/api`
  are proxied to the bridge (`packages/canvas/vite.config.ts`).
- **Backend (dev)**: the bridge builds one `@libsql/client` (node) — a local
  `.web-poc-dev.db` file — runs `web-poc/lib/db/migrations` on boot, reads
  `web-poc/.dev.vars`, and serves `buildApp` for `/v1/*` + `/api/auth/*`.
- **Backend (prod)**: the canvas container bakes `packages/canvas` (web-poc
  included); the canvas worker forwards web-poc's env (`TURSO_*`, `VOYAGE_API_KEY`,
  `BETTER_AUTH_*`, `WEB_ORIGIN`) into the container, pointing at remote Turso. See the canvas
  `Dockerfile` / `wrangler.jsonc` and `packages/infra/environments/production/canvas.ts`.

## Observation input API

`POST /v1/observations` accepts external input, authenticated with the
`x-api-key` header. Create a key in the web UI (Settings → API Keys), then:

```bash
curl -X POST http://localhost:4510/v1/observations \
  -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Checkout felt sluggish this morning",
    "body": "Several users reported 3-5s delays adding items to the cart.",
    "impact": "Lost conversions during peak hours",
    "projectTags": ["checkout"]
  }'
```

Fields: `title` (required, ≤300 chars) and `body` (required) are the minimum;
`impact` (string), `projectTags` (string[]), and `runAgent` (bool, default
`true`) are optional. `runAgent` only gates the optional LLM agent job —
**embedding happens inline regardless**, so the observation is searchable
immediately. Returns the created observation (HTTP 201); find it with
`GET /v1/graph/search?q=...` or `GET /v1/observations`. Same shape for problems
via `POST /v1/problems`.

## Scripts

All tooling runs as `webpoc:*` scripts on the **canvas** package (run from
`packages/canvas`); they `cd web-poc` and invoke the tool there.

| Script | Purpose |
|---|---|
| `webpoc:typecheck` / `webpoc:test` | `tsc --noEmit` / vitest (over `web-poc/`) |
| `webpoc:db:generate` / `webpoc:db:migrate` | Drizzle generate (via `bunx --bun`) / apply migrations |
| `webpoc:gen:api` / `webpoc:openapi:emit` | regen `src/api-types.ts` from `openapi.json` / emit `openapi.json` from the contract |
| `webpoc:seed` | seed demo data |

The optional agent-jobs consumer is `bun scripts/worker.ts` (run from `web-poc/`).

## Deploy

**One path, via canvas.** web-poc ships baked into the single `agent-canvas`
Cloudflare container — there is no standalone web-poc worker anymore (its
`wrangler.jsonc` and `infra/.../web-poc.ts` target were removed in the merge).
Deploy the whole stack with `packages/canvas/scripts/deploy.sh`
(`zbc apply production canvas`); web-poc's secrets (`TURSO_URL`, `TURSO_KEY`,
`VOYAGE_API_KEY`, `BETTER_AUTH_SECRET`) ride the canvas worker
(`infra/.../canvas.ts` `workerSecrets`, from SOPS `secrets.yaml`). **Migrations
are not run by the deploy** — apply them to prod Turso separately
(`bun run webpoc:db:migrate` with prod `TURSO_URL`/`TURSO_KEY`).

## Docs

- `CONTEXT.md` — domain language + dev workflow (start here)
- `MIGRATION.md` — what changed from apex (file map, env, Voyage, inline flow, cron)
- `docs/` — architecture references (read `docs/README.md` for the migration delta)
- `CLAUDE.md` — rules for AI sessions working in this package
