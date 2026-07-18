# Context Map

> **Product thesis:** [docs/POSITIONING.md](./docs/POSITIONING.md) — why cedarpad
> exists (the alignment medium; live components as the vocabulary). Marketing and
> roadmap decisions start there.

> **Workspace platform frame (target model, being designed):** [CONTEXT.md](./CONTEXT.md)
> — the Workspace runtime, edge Shell, and App layer (Canvas / Notebook / Inbox) that
> sit *above* the per-package contexts below.

## Contexts

- [App](./packages/app/CONTEXT.md) — the cedarpad outliner + per-node Claude conversations
- [Canvas](./packages/canvas/CONTEXT.md) — tldraw canvas with a built-in Claude chat agent that draws on it and reads from it
- [Infra](./packages/infra/CONTEXT.md) — module instances and environments managed by `zbc apply`
- [Web POC](./packages/web-poc/CONTEXT.md) — single Cloudflare Worker serving a Vite/React SPA + Hono `/api/*`
- [WWW](./packages/www/CONTEXT.md) — Astro marketing site + waitlist at `cedarpad.com` (ADR-0014)

## Relationships

- **App → Infra**: App is one of the deployed targets that Infra Instances provision (Vercel project, database, etc.)
- **Web POC → Infra**: Web POC is deployed by the `cloudflare` module instance, which builds it and runs `wrangler deploy`.
- **Canvas → Infra**: Canvas is deployed by the `cloudflare` module instance (`zbc apply production canvas`) to the `agent-canvas` worker + R2 bucket on the `cedarpad.com` zone.

_Note: `packages/app/` is currently only a CONTEXT.md placeholder — the package itself isn't scaffolded yet. Final name TBD._
