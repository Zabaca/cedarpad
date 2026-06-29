# @cedarpad/web-poc

The Cedarpad app as a **single Cloudflare Worker** that serves a Vite-built React
SPA and a co-located Hono API, backed by **Turso** (libSQL) with **Voyage**
embeddings for semantic search. Migrated from the apex monorepo (two deploy
targets + 5 packages) into one deployable package.

## Stack

- **SPA** (`src/`) — React 18, Mantine, React Query, zustand, Better Auth client,
  openapi-fetch, Ably. Served as static Assets by the Worker.
- **Worker** (`worker/`) — Hono + `@hono/zod-openapi`. Routes: `/api/auth/*`
  (Better Auth), `/v1/*` (the contract), `/health`, `/doc`, `/ui`. `export
  default app`.
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
  classification/linking/synthesis) is **optional and inert** unless you run
  `bun run dev:worker`.

## Local dev

Requires the `turso` CLI (for the local libSQL daemon — workerd has no filesystem).

```bash
cp .dev.vars.example .dev.vars     # fill VOYAGE_API_KEY for semantic embeddings
                                   # (without it, a local hash fallback is used)
bun install                        # from the cedarpad repo root
bun run dev:db                     # terminal 1: local turso daemon on :8081
bun run db:migrate                 # once, against the daemon
bun run dev                        # terminal 2: Vite + Worker in workerd (HMR)
# optional: bun run dev:worker     # process LLM agent jobs (not needed for embed/search)
```

Open the printed `localhost:<port>`. The SPA and API share one origin.

## Observation input API

`POST /v1/observations` accepts external input, authenticated with the
`x-api-key` header. Create a key in the web UI (Settings → API Keys), then:

```bash
curl -X POST http://localhost:<port>/v1/observations \
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

| Script | Purpose |
|---|---|
| `dev` / `dev:db` / `dev:worker` | Vite+Worker / local Turso daemon / optional agent-jobs consumer |
| `build` / `preview` / `deploy` | Vite build / local preview / `wrangler deploy` |
| `typecheck` / `test` | `tsc --noEmit` / vitest |
| `db:generate` / `db:migrate` | Drizzle generate (via `bunx --bun`) / apply migrations |
| `gen:api` / `openapi:emit` | regen `src/api-types.ts` from `openapi.json` / emit `openapi.json` from the contract |
| `seed` | seed demo data |

## Deploy

Deployed by the zbc cloudflare module
(`packages/infra/environments/production/web-poc.ts`): `bun run build` →
`wrangler deploy` → push Worker secrets (`TURSO_URL`, `TURSO_KEY`,
`VOYAGE_API_KEY`, `ABLY_API_KEY`, `BETTER_AUTH_SECRET`, optional
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`) from SOPS `secrets.yaml`. A push to `main`
touching `packages/web-poc/**` auto-deploys. **Migrations are not run by the
deploy** — apply them to prod Turso separately (`bun run db:migrate` with prod
`TURSO_URL`/`TURSO_KEY`).

## Docs

- `CONTEXT.md` — domain language + dev workflow (start here)
- `MIGRATION.md` — what changed from apex (file map, env, Voyage, inline flow, cron)
- `docs/` — architecture references (read `docs/README.md` for the migration delta)
- `CLAUDE.md` — rules for AI sessions working in this package
