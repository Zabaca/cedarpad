---
name: worktree
description: How parallel-safe git-worktree development works in cedarpad — agent hygiene (stay in your worktree, don't write to the main checkout), the per-worktree local-D1 state dir, per-worktree dev/e2e ports, the E2E_MODE shim convention, and the Playwright authoring loop for the canvas app. Use when working as an agent inside a git worktree, running the dev server / tests / e2e from a worktree, authoring an e2e spec, adding an E2E_MODE shim, or debugging a "port already in use" / shared-DB collision.
user-invocable: true
---

# Worktree Development (cedarpad)

This repo follows CLAUDE.md §6 (worktree-safe by default) and ADR-0003
(parallel-via-worktrees). Multiple worktrees can run the canvas dev stack,
unit tests, and Playwright e2e at the same time without colliding on ports or
dev databases. Everything below lives under `packages/canvas` (the deployable
app).

---

## Agent hygiene — STAY IN YOUR WORKTREE

If you are an agent working in a git worktree (path under `.claude/worktrees/…`),
read this first. It is separate from the port/DB isolation below: that keeps
parallel *processes* from colliding; this keeps you from writing to the wrong
*checkout*.

**The failure mode:** an agent in a worktree runs a command like
`cd /Users/uptown/Projects/zabaca/cedarpad && …` (the *main* checkout) and edits
or commits there instead of in its worktree. It has happened repeatedly. It's
dangerous because the main checkout may hold the human's own uncommitted work, or
another agent's — a stray write there can block a `git pull`, collide, or get lost.
Nothing in the port/DB scaffolding prevents it, because it's a wrong-directory
problem, not a port problem.

**Why the pull toward main exists — and how to resist each:**

1. **Your environment says the project is at the main path.** The system context
   advertises the repo's *main* working directory (`/Users/uptown/Projects/zabaca/cedarpad`).
   That is NOT where you are. Do not trust it as your cwd. **Run
   `git rev-parse --show-toplevel` first and treat *that* as your root** — it will be
   a `.claude/worktrees/agent-…` path.

2. **Your worktree has no `node_modules`.** A worktree shares `.git` but not
   untracked files, so tools may fail until deps exist. **`bun install` inside your
   own worktree** (it won't change `bun.lock`). Do NOT `cd` to main to borrow its
   `node_modules`.

3. **Habit.** "cd to the project and run the command" is reflex, and the path you
   memorized is main.

**Rules:**

- **Never put an absolute path to the main checkout in any command** — not in a bare
  `cd`, and *especially* not inside a compound `cd /main/path && …` or a
  `cat >> /main/path/file` heredoc. Each Bash call is a fresh shell, so a `cd` inside
  one command silently retargets just that command; that is exactly how the escapes
  happened.
- **Prefer paths relative to your worktree**, or absolute paths *under* your
  `git rev-parse --show-toplevel`. Run `pwd` before any write if unsure.
- **`git status` / `git add` / `git commit` operate on your worktree** as long as you
  don't `cd` out of it. If a git command reports files you didn't touch, STOP — you're
  in the wrong checkout.

The harder structural fixes (not advertising the main path to worktree agents,
pre-seeding `node_modules`, hard-sandboxing the filesystem) are harness-level and out
of scope here — until they land, this discipline is the guard.

---

## Architecture

Two wrappers compose. Both derive their values deterministically from
`basename(git toplevel)`, so the same worktree always gets the same ports and
the same dev DB — collisions are impossible and `lsof -i :$PORT` is always
informative.

### `packages/canvas/scripts/with-worktree-port.sh`

Hashes the worktree basename into an even base port in `[4520, 4900)` and
exports:

- `PORT` — vite dev server port. `vite.config.ts` reads it (fallback `4510`).
- `CANVAS_BRIDGE_PORT` — bun bridge listen port (`= PORT + 1`). `server/bridge.ts`
  reads it (fallback `4511`); `scripts/dev.ts` derives the vite `/api` proxy
  target (`CANVAS_BRIDGE`) from it so the browser proxies to the bridge this
  stack started.
- `CANVAS_EDGE_PORT` — edge Worker (`wrangler dev`) listen port (`= PORT + 3`;
  `scripts/dev.ts` derives the vite `/v1` + `/api/auth` proxy target from it).
  `+3`, not `+2`: `4512` belongs to the extension server.
- `E2E_BASE_URL` — `http://localhost:$PORT`, Playwright's `baseURL`.
- `E2E_MODE=1` — flag e2e-aware code can read to short-circuit real auth /
  external calls (see the shim convention below).

### `packages/canvas/scripts/with-worktree-db.sh`

Since **ADR-0018** local dev's **platform data layer** is miniflare's local D1, bound
to the edge Worker — not a libSQL file the bridge migrates on boot. So what this
wrapper isolates is miniflare's **state directory**: it derives
`.wrangler/state-<worktree>` and exports it as `CANVAS_D1_STATE`. Both the edge Worker
(`wrangler dev --persist-to`) and the bridge (`server/local-d1.ts`, which opens the
same D1 file so dev has ONE datastore) read it.

**Migrations are explicit now** — nothing runs on boot:

```sh
bun run webpoc:db:migrate:local        # the canonical .wrangler/state (plain `bun run dev`)
bun run webpoc:db:migrate:local:e2e    # this worktree's state-<worktree> dir (`dev:e2e`)
```

Booting the bridge against an unmigrated state dir fails with an error naming the
command. Worse ergonomics than the old auto-migrate, better prod parity — a deliberate
trade (ADR-0018). `test:e2e` needs no extra step: Playwright's `globalSetup` applies
them.

> **Default behavior is preserved.** With none of these env vars set — a plain
> `bun run dev` — the ports are `4510`/`4511`/`4513` and the state dir is
> `packages/canvas/.wrangler/state`. The wrappers are opt-in via the `:e2e` scripts.

The canonical composition is `with-worktree-port.sh with-worktree-db.sh <cmd>`,
already wired into the `package.json` scripts below.

---

## Running things in a worktree

From `packages/canvas`:

```sh
bun test                 # unit tests (bun test ./server ./src ./worker) — in-memory DBs, already parallel-safe
bun run dev:e2e          # dev stack on the worktree's derived port + DB
bun run test:e2e         # Playwright over the dev stack (isolated port + DB)
bun run test:e2e:ui      # Playwright UI mode for iterating
```

`dev:e2e` starts a heavier stack than it used to: vite + bridge + **the edge Worker**
(ADR-0018), because the platform data layer is now served locally by the edge.

Open multiple worktrees and run these in parallel — each hits a different port
and a different local D1 state dir. No coordination needed. (`bun run dev` stays on the
canonical `4510`/`4511`; use `dev:e2e` when you need isolation.)

---

## The `E2E_MODE` shim convention

The canvas app is gated by Better Auth + the `cs_gate` cookie. A full
authenticated e2e flow needs a signed-in session, which is expensive to set up
per run. The convention for making gated / external-dependent paths hermetic in
e2e is a gated early return keyed off `E2E_MODE`:

```ts
if (process.env.NODE_ENV !== 'production' && process.env.E2E_MODE === '1') {
  // deterministic response matching the live shape, or a bypass of cs_gate /
  // a seeded test session for the Shell flow.
}
```

### Rules

1. **Belt-and-suspenders the prod gate.** Require `NODE_ENV !== 'production'`
   AND `E2E_MODE === '1'`. Either alone is not enough — the shim must be
   unreachable in prod.
2. **Place the shim AFTER real auth checks** where one exists, so a future
   auth regression surfaces rather than being papered over.
3. **Match the live response shape exactly** — every field.
4. **Shim only what blocks e2e** (auth gate, outbound email, third-party
   verification), not list/read endpoints.
5. **Mention any new shim in the PR body** so reviewers know what changed.

`with-worktree-port.sh` already exports `E2E_MODE=1`, so any spec run through
`test:e2e` gets it for free.

---

## Authoring a new e2e spec

Specs live in `packages/canvas/e2e/specs/*.spec.ts` and import `test` / `expect`
from `../fixtures/test.ts` (never `@playwright/test` directly) so future
fixtures (auth cookie, seeded workspace) land in one place.

### The loop

1. Start the dev stack in this worktree: `bun run dev:e2e &`. It prints the
   derived `$PORT` / `$E2E_BASE_URL`.
2. Drive the running server (Playwright codegen, or the Playwright MCP if
   registered) at `$E2E_BASE_URL` to discover stable role/label locators rather
   than guessing them.
3. Write the spec, then run `bun run test:e2e` (Playwright's `webServer` will
   reuse the already-running dev server locally).
4. Iterate until green. Commit.

### Conventions

- Use unique-per-run identifiers (e.g. `` `e2e-${Date.now()}@example.com` ``) so
  a spec doesn't collide with a previous run in this worktree's dev DB.
- Don't `test.skip` / `test.fixme` to make CI green — fix or remove the spec.

---

## Current specs

- `e2e/specs/smoke.spec.ts` — proves the harness round-trips: the wrappers
  derive a port + DB, Playwright launches the canvas dev stack on that port, and
  the app shell (`<title>Agent Canvas</title>`, `#root`) renders. No auth.

### Deferred follow-up

The fuller **Shell flow** for #46 (dev signup → sign in → Shell → create/switch
workspace → open canvas → sign-out) is not yet implemented as a spec. It needs
an `E2E_MODE` shim to bypass `cs_gate` and/or seed a test session. Track it as a
follow-up to #71.

---

## Troubleshooting

- **"port already in use"** — two worktrees with the same basename (rename one),
  or you started both `dev` and `dev:e2e` in the same worktree.
- **Playwright starts its own server unexpectedly** — locally `webServer`
  reuses an existing one; make sure your `dev:e2e` is on the derived `$PORT`.
- **Stale dev DB** — delete `packages/canvas/.wrangler/state-<worktree>/`, then
  re-run `bun run webpoc:db:migrate:local:e2e`.
- **"No local D1 database in …"** — the state dir has never been migrated; run the
  migrate command above (nothing migrates on boot any more).
- **CI** — `.github/workflows/e2e.yml` runs `bun run test:e2e` with `CI=true`,
  which flips Playwright to no-reuse + retries and launches a fresh dev stack.
