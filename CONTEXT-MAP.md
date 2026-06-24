# Context Map

## Contexts

- [App](./packages/app/CONTEXT.md) — the cedarpad outliner + per-node Claude conversations
- [Infra](./packages/infra/CONTEXT.md) — module instances and environments managed by `zbc apply`
- [Web POC](./packages/web-poc/CONTEXT.md) — single Cloudflare Worker serving a Vite/React SPA + Hono `/api/*`

## Relationships

- **App → Infra**: App is one of the deployed targets that Infra Instances provision (Vercel project, database, etc.)
- **Web POC → Infra**: Web POC is deployed by the `cloudflare` module instance, which builds it and runs `wrangler deploy`.

_Note: `packages/app/` is currently only a CONTEXT.md placeholder — the package itself isn't scaffolded yet. Final name TBD._
