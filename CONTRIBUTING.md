# Contributing

Thank you for wanting to help. [`README.md`](README.md) says what cedarpad is and how to run it. This is how to
send a change.

## Before you write code

- **Open an issue first** for anything bigger than a small fix, so you don't build something we won't merge.
- **Report a vulnerability privately**, not as an issue or a pull request: see [`SECURITY.md`](SECURITY.md).
- **Sign the contributor agreement.** Read [`CLA.md`](CLA.md). Your first pull request needs a comment saying
  "I have read the CLA and I agree to it." A maintainer checks for it by hand, adds you to
  [`CONTRIBUTORS-CLA.md`](CONTRIBUTORS-CLA.md), and we don't merge a pull request without it. Why we ask is in the
  agreement's first paragraph. (Zabaca LLC's own staff and its contractors do not sign: their work is covered by their
  own agreements with it.)

## Build and check

Work from `packages/canvas` after `bun install` at the repository root. A change must leave these clean, with every
error and every new warning fixed:

```bash
bun run typecheck           # canvas and the edge Worker
bun run webpoc:typecheck    # the data layer, separately
bun run test                # server, shared, src, shell, worker (bun test, scoped)
bun run webpoc:test         # the data layer (vitest)
```

**Never run a bare `bun test` in `packages/canvas`.** Its default glob collects the data layer's vitest specs under
the wrong runner and reports about ten failures that are not real. The package scripts are scoped to avoid it.
`bun run test:e2e` runs the Playwright suite (it needs `bunx playwright install chromium`); run it when your change
touches what it covers. A change under `packages/www` is checked there with `bun run test`, `bun run typecheck` and
`bun run lint`.

CI runs the same checks on every pull request.

## How to change the code

- **Keep a change as small as it can be.** No drive-by refactors, no abstractions for a single use, no new
  dependency without a reason in the pull request. Match the code around it.
- **Test what you change.** A bug fix starts with a test that fails for the bug.
- **One contract across a boundary.** Everything that crosses a process boundary or is stored as JSON is typed by
  one zod schema that both sides parse. A schema change is a contract change.
- **Run beside copies of itself.** Ports come from the environment, a database name includes the worktree, and no test
  uses a fixed `/tmp` path or a fixture shared across processes.
- **No secrets, no personal data.** Never commit a token, a key, a `.env` file or an address that isn't yours to
  publish. Use made-up values in examples and tests.

The words the code and docs use are in [`CONTEXT-MAP.md`](CONTEXT-MAP.md) and the `CONTEXT.md` it points to; the
decisions behind the design are in [`docs/adr`](docs/adr) and [`packages/canvas/docs/adr`](packages/canvas/docs/adr).

## Sending the pull request

- Describe why the change is needed, not only what it does, and say what you checked and what you didn't.
- Pull requests from outside the team run CI only after a maintainer approves the run. Expect a delay.
- A maintainer squash-merges it.

## Licence of your contribution

Your contribution is licensed under [`LICENSE`](LICENSE) like the rest of the repository, and, as
[`CLA.md`](CLA.md) says, also to Zabaca on terms that let it relicense the code.
