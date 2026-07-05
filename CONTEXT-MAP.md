# Context Map

## Contexts

- [App](./packages/app/CONTEXT.md) — the cedarpad outliner + per-node Claude conversations
- [Infra](./packages/infra/CONTEXT.md) — module instances and environments managed by `zbc apply`
- [Canvas](./packages/canvas/CONTEXT.md) — ONE application, two surfaces behind one Better Auth login:
  the tldraw canvas + chat agent, and **Notebook** (the Problem/Solution intelligence app, formerly
  "web-poc": React SPA at `src/notebook/`, Hono `/v1` API at `server/notebook/`, shared libs in `lib/`).
  Deployed as a single Cloudflare Worker + container. Notebook domain docs: [docs/notebook/](./packages/canvas/docs/notebook/).

## Relationships

- **App → Infra**: App is one of the deployed targets that Infra Instances provision (Vercel project, database, etc.)
- **Canvas → Infra**: the `canvas` instance deploys the `agent-canvas` Worker (`zbc apply production canvas`),
  which carries Notebook's secrets (Turso, Better Auth, Voyage) as workerSecrets.

_Note: `packages/app/` is currently only a CONTEXT.md placeholder — the package itself isn't scaffolded yet. Final name TBD._
