# Web POC

A single Cloudflare Worker that serves a Vite-built React **SPA** and hosts an
`/api/*` **Hono** backend — one codebase, local dev fully local, production on
Cloudflare's edge. Proves the Next-on-Vercel "frontend + co-located `api/`"
ergonomics without Next.

## Language

**SPA**:
The Vite-built React client (`src/`, `index.html`). In production it is served as
static **Assets** by the Worker; unmatched routes fall back to `index.html`
(`not_found_handling: single-page-application`).
_Avoid_: frontend, site

**Worker**:
The `workerd` script (`worker/index.ts`) — a Hono app mounted under `/api/*`.
`run_worker_first: ["/api/*"]` makes those paths hit the Worker *before* the SPA
asset fallback. Same code runs in local dev (`vite` + `@cloudflare/vite-plugin`)
and on the edge.
_Avoid_: server, backend, lambda

**Local DB daemon**:
`turso dev` (sqld) backing `./.turso-local.db`, served over HTTP. `workerd` has
no filesystem, so the Worker cannot open a `file:` DB directly — local dev points
`TURSO_URL` at this daemon. Started with `bun run dev:db`.
_Avoid_: sqlite, local turso

**Turso**:
The managed libSQL database used in production only. The Worker code is identical
across environments (`createClient({ url: env.TURSO_URL, authToken: env.TURSO_KEY
|| undefined })`); only the env differs (`.dev.vars` local vs Worker secrets in
prod).

## Local dev (two terminals)

1. `bun run dev:db` — local sqld daemon (libSQL over HTTP at
   `http://127.0.0.1:${TURSO_DEV_PORT:-8081}`, matching `.dev.vars`).
2. `bun run dev` — Vite + the Worker in the real `workerd` runtime, with SPA HMR.

`.dev.vars` points the Worker at the local daemon; the real Turso creds are used
only at deploy time (pushed as Worker secrets by the `cloudflare` zbc module).

## Relationships

- **Web POC → Infra**: deployed by the `cloudflare` module instance
  (`packages/infra/environments/production/web-poc.ts`), which builds, runs
  `wrangler deploy`, and pushes `TURSO_URL`/`TURSO_KEY` as Worker secrets.
  A merge to `main` touching `packages/web-poc/**` or `packages/infra/**`
  auto-deploys via `.github/workflows/production.yml` (`zbc apply production
  web-poc`); it decrypts `secrets.yaml` with the `SOPS_AGE_KEY` CI key.
