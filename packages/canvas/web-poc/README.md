# web-poc (in-tree module of `@cedarpad/canvas`)

The platform data layer: D1 schema + migrations, the query modules the edge Worker uses, and
Better Auth (ADR-0018). See `CONTEXT.md` for the layout and `CLAUDE.md` for the rules.

The Notebook app that used to live here (React SPA + Hono `/v1` API) was removed when
cedarpad was cut back to the canvas; `MIGRATION.md` is the history of how this directory
came to be.

Everything runs from `packages/canvas`:

```sh
bun run webpoc:db:migrate:local   # apply migrations to the local D1
bun run webpoc:typecheck
bun run webpoc:test
```
