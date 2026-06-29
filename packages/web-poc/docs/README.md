# web-poc docs

Architecture/reference docs, migrated from the apex monorepo. They describe the
domain and subsystems; **read them through the migration delta below**, because
the code was restructured and a few design points changed after the move.

## Migration delta (read first)

This package flattened apex's two deploy targets + 5 workspace packages into one
Cloudflare Worker. When a doc says `apps/api/src/...`, `apps/web/src/...`, or
`@cedarpad/<pkg>` / `packages/<pkg>`, remap:

| Doc says | Now lives at |
|---|---|
| `apps/api/src/**` | `worker/**` |
| `apps/web/src/**` | `src/**` |
| `packages/{ai,config,contract,db,realtime}/src` | `lib/{ai,config,contract,db,realtime}` |
| `@cedarpad/<pkg>` import | relative `../lib/<pkg>/index.js` |

Design points that **changed** after migration (newer than the docs):

- **Embeddings → Voyage `voyage-3.5-lite`, 1024 dims** (was OpenAI
  `text-embedding-3-small`, 1536). `VOYAGE_API_KEY` selects it; deterministic
  local hash is the offline fallback.
- **Embedding is inline, not async.** Create (`createObservationRoute` /
  `createProblemRoute`) embeds the record (`input_type=document`) and stores it
  in the same insert; search embeds the query (`input_type=query`). So
  `ASYNC_PIPELINE.md`'s "embed happens in the agent job" is superseded — the
  agent job now only does LLM classification/linking/synthesis.
- **No background worker for the core loop.** The Cron/`scheduled` consumer was
  removed; the `agent_jobs` queue is **optional and inert** unless you run
  `bun run dev:worker`. (See `../MIGRATION.md` → "Async agent jobs".)
- **Env names**: `TURSO_URL` / `TURSO_KEY` (was `TURSO_DATABASE_URL` /
  `TURSO_AUTH_TOKEN`).
- **Migrations** live in `lib/db/migrations` (single clean baseline at 1024 dims).

## Index

- **SIMILARITY_SCALING.md** — why find-similar is a brute-force exact cosine scan
  (no ANN index), the benchmark, and the Turso scaling roadmap. *(Code references
  this path.)*
- **CONFIGURATION.md** — config-as-code vs secrets; env vars. *(Remap env names
  per above; embedding provider is now Voyage.)*
- **CONTRACT_ARCHITECTURE.md** — the single zod-openapi contract shared by SPA +
  worker; `openapi:emit` → `gen:api` regen flow. *(Still accurate; run the
  scripts from the web-poc root.)*
- **ASYNC_PIPELINE.md** — the `agent_jobs` queue + pipeline. *(Embedding step is
  now inline; the queue is optional — see delta above.)*
- **AGENT_GRAPH_ACCESS.md** — the read-only graph tools exposed to the LLM agent.
- **AGENT_SIM.md**, **MANUAL_AGENT_TESTING.md** — the manual reasoner bridge for
  testing the LLM agent without a provider key. *(Dev-only; unrelated to the
  inline embed/search loop.)*

The canonical, up-to-date docs for this package are `../CONTEXT.md` (domain
language + dev workflow), `../MIGRATION.md` (what changed from apex), and
`../README.md` (getting started).
