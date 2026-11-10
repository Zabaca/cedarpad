# web-poc — the platform data layer (in-tree module of canvas)

The D1 schema, migrations, query modules and Better Auth that the canvas edge Worker uses
(ADR-0018). The directory name is historical: it once held the Notebook (a React SPA plus a
Hono `/v1` API, ADR-0024), which was retired when cedarpad was cut back to the canvas.

## Layout

- `lib/db/` — Drizzle over D1: `schema.ts`, `migrations/` (config in `drizzle.config.ts`),
  `client.ts`, and `queries/` (`workspaces`, `canvases`, `invitations`, `share-links`,
  `mcp-tokens`). `test-d1.ts` is the test seam: a real local D1 with the migrations applied.
- `worker/` — edge-only helpers: `auth.ts` (`createAuth`, Better Auth: magic link, admin,
  organization-as-workspace, the MCP OAuth provider), `context.ts` (`Bindings`),
  `runtime.ts` (`createDbForWorker`, the db over the `PLATFORM_DB` binding), `email.ts`.

## Schema / migrations

Drizzle owns the schema and migrations. Generate with `bun run webpoc:db:generate` (from
`packages/canvas`); never hand-edit `.sql` or `meta/_journal.json`, and never roll back —
only forward-fix. The retired features' tables (the Notebook's, conversations, push
subscriptions, job stamps, connectors) are still in the schema until a forward migration
drops them.

## Local dev

1. `bun install` (repo root).
2. `cp web-poc/.dev.vars.example web-poc/.dev.vars` — `BETTER_AUTH_SECRET` and friends.
3. `cd packages/canvas && bun run webpoc:db:migrate:local` — apply the migrations to the
   local D1 (idempotent).
4. `cd packages/canvas && bun run dev`.

## Relationships

- **web-poc → Canvas**: it *is* part of canvas, imported by relative path from the edge
  Worker. `BETTER_AUTH_SECRET` rides the canvas worker secrets
  (`packages/infra/environments/production/canvas.ts`); `BETTER_AUTH_URL` / `WEB_ORIGIN` are
  plain vars in `packages/canvas/wrangler.jsonc`.
