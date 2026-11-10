# Workspace containers run on the `durable_object` policy; the Sandbox is retired

Status: **accepted** (2026-10-09). Amends canvas
[decision 0001](../../packages/canvas/docs/decisions/0001-cloudflare-container-deploy.md) (the
container deploy) and the verify step of [ADR-0025](./0025-a-release-is-a-deploy.md).
Vocabulary: root [CONTEXT.md](../../CONTEXT.md) — **Workspace**, **Product runtime**.

## Decision

Each workspace's dev stack (vite + bridge) runs in a container owned by its own
**`CanvasContainer` Durable Object** (`packages/canvas/worker/canvas-container.ts`), on
Cloudflare's `scheduling_policy: "durable_object"`. The DO starts the container itself
(`ctx.container.start`), polls readiness through vite, proxies HTTP/SSE/WebSocket to it,
and stops it 5 minutes after the last request finishes. It is the only container path:
the `@cloudflare/sandbox` `Sandbox` class, the retired `Warehouse` and the retired Inbox's
`WorkspaceEvents` are deleted (wrangler migration `v6`).

A workspace mapped in `SELF_HOSTED_WORKSPACES` still runs on our own hardware instead (an sbx
sandbox as `{ stack, supervisor }` origins; it sleeps, so its requests ask sbx to wake it and the
public build stamp does not; the VM this line once named is gone, see
[ADR-0028](./0028-the-default-workspace-runs-in-an-sbx-sandbox.md));
the routing order is unchanged: the E2E loopback shim, then a self-hosted sandbox, then the
workspace's `CanvasContainer`.

## Why

- The `Sandbox` extends `@cloudflare/containers`' `Container`, which cannot run under the
  new policy and is maintained only through 2026-12-31.
- Under the default policy every image change was a container-application PATCH plus a
  rollout: Cloudflare's 25s gateway cut those PATCHes off with 408s, rollouts settled in
  two stages, and a rollout could report "completed" with the stored image still on the
  previous digest (incident 2026-07-28). `deploy.sh` carried a retry, a settle wait and a
  stored-image check for exactly those failures. Under `durable_object` the image map ships
  with the Worker version: there is no PATCH and no rollout, and a running container takes
  a new image on its next request because its DO's boot fingerprint (image + env) no longer
  matches.
- Measured on preview (standard-1, no snapshots): ~30s for the first boot of a new image on
  a host, ~4–5s from idle afterwards, against 30–120s cold boots on the Sandbox.

## Consequences

- A Cloudflare deploy is `bun run apply production canvas` (zbc: Shell build, wrangler
  deploy, secrets) after the D1 migrations — `scripts/deploy.sh` does both and nothing else.
  The 408 retry, `settle_containers`, the stored-image check, `rollout-wait.sh`,
  `verify-container-image.sh` and `verify-cold-boot.sh` are gone with the failure modes
  they guarded.
- `/api/buildrev` follows the default workspace's compute: while `default` is self-hosted
  it reports the sandbox, so `deploy.sh`'s buildRev poll is skipped there and
  `bun run deploy:sandbox` is what proves it. An anonymous poll therefore
  never keeps a Cloudflare container awake for a workspace that does not run on one, and on a
  sandbox it is passive: it wakes nothing and boots nothing (a 503 while the sandbox sleeps).
- `wrangler deploy` does not delete container applications or detach custom domains that
  leave the config: the old `-sandbox` / `-warehouse` applications are deleted with
  `wrangler containers delete`, and a dropped custom domain through the Workers domains
  API, by hand after the deploy.
- Deleting a Durable Object class deletes its storage. None of the three held anything the
  platform still reads (the Sandbox's storage was its own boot bookkeeping).
