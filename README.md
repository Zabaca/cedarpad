# cedarpad

A shared canvas where a team and an AI agent work out what to build before anyone builds it. You sketch on a
[tldraw](https://tldraw.dev) canvas; you also chat with Claude, which draws on the same canvas, reads what you
drew, and builds small working things on it (charts, tables, diagrams, whole interface variants) as live React
components that everyone on the canvas can see and use.

The product is at [cedarpad.com](https://cedarpad.com). This repository is its source.

## What is here

| Path | What it is |
|---|---|
| [`packages/canvas`](packages/canvas) | The app. A web client, a bridge that runs the chat agent (Claude Agent SDK), and an edge Worker on Cloudflare that serves sign-in, the data layer and the canvas sync rooms. Start with [`CONTEXT.md`](packages/canvas/CONTEXT.md), its domain model. |
| [`packages/www`](packages/www) | The marketing site (Astro). |
| [`packages/infra`](packages/infra), [`zbc.config.ts`](zbc.config.ts) | How Zabaca deploys cedarpad with [zbc](https://github.com/Zabaca/zbc). See "Running it for real users". |
| [`vendor/zbc`](vendor/zbc) | zbc's built-in modules, vendored unchanged. |
| [`docs/adr`](docs/adr), [`packages/canvas/docs/adr`](packages/canvas/docs/adr) | The decisions behind the design, one per file. |

## Run it locally

You need [Bun](https://bun.sh) 1.3.4, Node 22 (wrangler refuses to run under Bun) and a Claude Code login or an
`ANTHROPIC_API_KEY` for the chat agent.

```bash
bun install
cd packages/canvas
cp web-poc/.dev.vars.example web-poc/.dev.vars
bun run webpoc:db:migrate:local
bun run dev          # open http://localhost:4510
```

`bun run dev` starts the bridge (:4511), the web app (:4510) and the edge Worker (:4513) against a local D1 database.

Check a change with the package's scripts, from `packages/canvas`:

```bash
bun run typecheck && bun run webpoc:typecheck   # types
bun run test                                    # server, shared, src, shell, worker
bun run webpoc:test                             # the data layer (vitest)
bun run test:e2e                                # Playwright; needs `bunx playwright install chromium`
```

Never run a bare `bun test` in `packages/canvas`: it collects the data layer's vitest specs under the wrong runner
and reports failures that are not real. [`CONTRIBUTING.md`](CONTRIBUTING.md) says more.

## Running it for real users

Running cedarpad for people other than yourself takes three things this repository does not give you:

- **Your own Cloudflare account.** The app deploys as a Worker, a Durable Object per workspace, D1 and R2.
  `packages/infra` and the `wrangler.jsonc` files describe Zabaca's own account and domains. They are a worked
  example, not a template you can apply: Zabaca's secrets files in `packages/infra/environments` are encrypted to
  Zabaca's keys and open for nobody else.
- **Your own tldraw licence key.** The canvas is tldraw 5.2.5, which has its own licence. It is free to develop
  with and needs a trial or a licence key in production. cedarpad's licence does not change that, and no key is
  in this repository. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- **A Claude credential** for the chat agent, supplied to the workspace's runtime.

## Licence

cedarpad is [Fair Source](https://fair.io), under the Functional Source License 1.1 with an Apache 2.0 future
licence ([`LICENSE`](LICENSE)). You can use it, at work too, read and change the code, and send changes back. What
you can't do is offer it, or a fork of it, in a commercial product or service that competes with cedarpad. Two years
after each version is released, that version is also yours under the Apache License 2.0, with no such limit.

Third-party code is listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md); it keeps its own licences.

**Trademarks.** "cedarpad" and the cedarpad logo are Zabaca's trademarks, and the licence does not grant them. A fork
needs its own name and logo; it may say it is based on cedarpad.

## Contributing and security

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request, and [`SECURITY.md`](SECURITY.md) to report a
vulnerability, privately.

Copyright 2026 Zabaca.
