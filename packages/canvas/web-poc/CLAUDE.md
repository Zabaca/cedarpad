# CLAUDE.md — web-poc (the platform data layer)

Rules and orientation for AI sessions working in this directory. Read `CONTEXT.md` for the
layout; `MIGRATION.md` is history.

## What this is

The **platform data layer** of `@cedarpad/canvas`: the D1 schema, its migrations, the query
modules the edge Worker uses, and Better Auth (ADR-0018). `web-poc` is a legacy directory
name — this used to also hold the Notebook app (SPA + `/v1` API), retired in favour of the
canvas.

It is an in-tree module, not a package: no `package.json`/`exports` of its own (canvas owns
the deps) and canvas imports it by **relative path**. Its consumers are the edge Worker
(`packages/canvas/worker/*`) and a few scripts; the container/bridge holds no database
client at all.

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

### Deploys — never without explicit approval
This ships as part of canvas. Do not deploy unless the user explicitly asks in this session.
Local dev/build/typecheck are always fine.

### Secrets
Never commit real secrets. Local dev uses `web-poc/.dev.vars` (gitignored). Production
secrets live SOPS-encrypted in `packages/infra/environments/production/secrets.yaml` and are
pushed as Worker secrets by the zbc module (`workerSecrets` in `canvas.ts`).

## Dev / test workflow

- Run the stack from canvas: `cd packages/canvas && bun run dev` (vite + bridge + the edge
  Worker, which serves `/api/auth/*` against miniflare's local D1). Apply migrations with
  `bun run webpoc:db:migrate:local`.
- `bun run webpoc:typecheck` and `bun run webpoc:test` (vitest, against a real local D1 —
  `lib/db/test-d1.ts`) must stay green. Tests are excluded from typecheck.
