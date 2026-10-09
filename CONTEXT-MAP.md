# Context Map

> **Product thesis:** [docs/POSITIONING.md](./docs/POSITIONING.md) — why cedarpad
> exists (the alignment medium; live components as the vocabulary). Marketing and
> roadmap decisions start there.

> **Workspace platform frame (target model, being designed):** [CONTEXT.md](./CONTEXT.md)
> — the Workspace runtime, edge Shell, and App layer (Canvas / Notebook) that
> sit *above* the per-package contexts below.

## Contexts

- [Canvas](./packages/canvas/CONTEXT.md) — tldraw canvas with a built-in Claude chat agent that draws on it and reads from it
- [Infra](./packages/infra/CONTEXT.md) — module instances and environments managed by `bun run apply`
- [Notebook / platform data layer](./packages/canvas/web-poc/) — the Notebook app (Observations/Problems, `buildApp`'s `/v1/*`) **and** the **platform data layer** (schema, query modules, migrations) that every App consumes. Mounted at the **edge** inside the canvas worker (ADR-0007 #56), not its own Worker. `web-poc` is a legacy directory name; see root [CONTEXT.md](./CONTEXT.md) for the term.
- [WWW](./packages/www/CONTEXT.md) — Astro marketing site + waitlist at `cedarpad.com` (ADR-0014)

## Relationships

- **Web POC → Infra**: Web POC is deployed by the `cloudflare` module instance, which builds it and runs `wrangler deploy`.
- **Canvas → Infra**: Canvas is deployed by the `cloudflare` module instance (`bun run apply production canvas`) to the `agent-canvas` worker + R2 bucket on the `cedarpad.com` zone.
