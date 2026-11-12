# The default workspace runs in an sbx sandbox that sleeps when idle

Status: **accepted** (2026-11-09). Amends [ADR-0027](./0027-workspace-containers-run-on-the-durable-object-policy.md)
(the self-hosted path now serves a sandbox, not a VM) and the verify step of
[ADR-0025](./0025-a-release-is-a-deploy.md) (`deploy:sandbox` replaces `deploy:vm`).
Vocabulary: root [CONTEXT.md](../../CONTEXT.md): **Workspace**, **Product runtime**.

## Decision

The `default` workspace's dev stack (vite, the bridge and the supervisor that boots them) runs in a
**sandbox on Zabaca's sandbox site (sbx)**, named `cedarpad-default`, built from an image of its own
(`packages/canvas/Dockerfile`, its `sandbox` form). It sleeps when idle and wakes on the next request.
The Worker reaches it through `SELF_HOSTED_WORKSPACES` in `packages/canvas/wrangler.jsonc`, whose entry
names two addresses: the stack at `https://cedarpad-default.sbx.zabaca.com` and the supervisor's
`/__boot` at `https://4599-cedarpad-default.sbx.zabaca.com`. It went live with v0.5.1 on 2026-11-09.

It replaces the incus VM `cedarpad-ws` on ryzen-9, which is deleted. Nothing about the workspace's data
moved: canvas state is in `CanvasSyncRoom`, rows are in D1, artifacts and the agent's session files are
in R2 (ADR-0022).

- **Sleep and wake.** Every request the Worker forwards to the sandbox carries `X-Sbx-Wake`, which asks
  sbx to wake it whatever the request looks like. sbx's 410 (the sandbox is lost) is treated as a stack
  that is down, because the sandbox is flagged to start fresh from its image when lost, and the boot
  that follows brings the stack up. vite's dependency pre-bundle is built into the image and kept on the
  sandbox's disk across sleep, so a wake does not rebuild it (the 2026-08-14 race that put the workspace
  on a VM in the first place).
- **The gates are declared in Home, not here.** Two Cloudflare Access applications, one per address
  (`cedarpad sandbox (cedarpad-default.sbx.zabaca.com)` and
  `cedarpad sandbox supervisor (4599-cedarpad-default.sbx.zabaca.com)`), each with one Service Auth
  policy that admits only the Access service token `cedarpad-edge-worker`: no person, session `0s`, so
  every request is evaluated and no cookie is issued. They are more specific than the site's wildcard
  application, which admits James's sign-in. sbx admits only the supervisor's port (4599) by prefix
  (`--open-port 4599`, set at create), so no other `<port>-cedarpad-default` name reaches the pod. The
  trust boundary is unchanged: the browser never talks to the sandbox, the Worker has already run Better
  Auth and the ownership check, and the sandbox's addresses admit exactly one caller.
- **Claude reaches Anthropic through claude-mitm-proxy.** The sandbox is created with the model route
  `anthropic`: sbx's egress proxy passes the sandbox's connections to `api.anthropic.com` to
  claude-mitm-proxy on the host, which swaps the fleet placeholder the Worker pushes for the real token.
  The real token is never in the sandbox or its cluster. The image carries the proxy's certificate
  (`NODE_EXTRA_CA_CERTS`). The sandbox may reach only the hosts in `sandbox/workspace.env`
  (`EGRESS_ALLOW`) beyond the site's own list.
- **Deploy is `bun run deploy:sandbox`** (`packages/canvas/scripts/deploy-sandbox.sh`), from James's Mac.
  It archives `origin/main` (the release passes `SANDBOX_DEPLOY_REF=<the commit it pushed>` so a merge
  meanwhile cannot move it), builds the image on the site's build machine (since 2026-11-11 in the site's builder, a pod: see
  Consequences) with the commit and version as
  build arguments (the stamps inside, as `deploy.sh` writes them into the container image), creates the
  sandbox the first time or replaces its image after (name, address, environment, command and allow-list
  are kept), and fails unless the supervisor answers, the pre-bundle is present and the stamps read
  **inside the sandbox** are `origin/main`'s. What the sandbox is (name, ports, size, route, allow-list)
  is `packages/canvas/sandbox/workspace.env`; no zbc module exists for sandboxes, so that file and the
  script are the record. The release skill runs it before the tag (ADR-0025).
- **`/api/buildrev` is passive for a sandbox.** It never wakes the sandbox or boots its stack, so it
  answers 503 while the sandbox sleeps. The script's own stamp check, with `deploy.sh`'s success, is
  the gate for the tag and needs no visit; that route is read after the next visit and is pending until then.

## Why

The VM held **8.54 GiB** of ryzen-9's memory around the clock, on a box whose memory is overbooked, for
a workspace whose own work is about 1.2 GiB and which started a dozen times in two weeks (the bridge
already exits 90 seconds after the last tab stops sending its heartbeat, so what the VM kept was its
disk, not a running stack). A sandbox that sleeps holds none of that while nobody is using it, and keeps
the disk. The VM also kept the box's only guest-to-host firewall opening alive and had a deploy path
of its own, a converge over incus with cedarpad's own identity.

## What was deleted

- The VM `cedarpad-ws`, its Cloudflare tunnel, the `ws.cedarpad.com` DNS record and its Access
  application (by hand: zbc modules never delete).
- cedarpad's `workspace` zbc environment (`packages/infra/environments/workspace/`: the VM, its
  provisioning, the checkout and service, the tunnel and its runner, the scoped token, the Access policy,
  the README and `secrets.yaml`), the environment's entry in `zbc.config.ts`, and the VM deploy script
  `packages/canvas/scripts/deploy-vm.sh` with its `deploy:vm` entry.
- The way back. With the VM gone, emptying `SELF_HOSTED_WORKSPACES` routes every workspace to its
  Cloudflare Container, whose agent cannot authenticate: its Claude secret is the fleet placeholder, which
  only claude-mitm-proxy can swap. That fallback keeps the pad but not the chat.

## Consequences

- **The plain-origin map entry is supported code with no live user.** `worker/self-hosted.ts` still
  parses `"<workspace>": "https://origin"` (one address for the stack and the supervisor, the VM's shape)
  and the admin page labels it `VM`. Nothing is mapped that way now; it stays so the Worker is not
  refactored in a clean-up change, and a later change may remove it.
- **The Access service token `cedarpad-edge-worker` stays.** The Worker presents it to both sandbox
  gates (`CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`). Its declaration in this repo (`ws-access`)
  is gone with the environment; Home's two gate applications find it by name and would mint a new one if
  it were ever deleted, so never delete it. A rotation is no longer a zbc apply from here: rotate it
  through the Cloudflare API (a short-lived scoped token), put the new secret in
  `production/secrets.yaml` and the Worker, and Home's gates follow it by name. It expires 2027-08-15
  (unverified); nothing renews it.
- **The supervisor's bearer** (`WS_SUPERVISOR_TOKEN`) is stored once, at the sandbox's create, as its
  stored environment; a replace keeps it. Rotating it means deleting the sandbox, running
  `deploy:sandbox` again, and redeploying the Worker's secret to the same value.
- **A release now needs the sandbox site reachable** and the sandbox's own stamp check to pass before the
  tag. It no longer needs cedarpad's own incus identity, which only the VM's converge used. (When this was
  written it still needed the `ryzen-9` incus remote on the Mac, because `sbx image build` drove the site's
  build machine, an incus guest on ryzen-9, over it. Since 2026-11-11 that guest is gone: `sbx image build`
  builds in the site's builder, a BuildKit pod, through `kubectl` and the tunnel to the cluster's API with
  the image service's builder credential, and no incus identity is needed.)
- **The first request after idle is slower** than a VM's: the wake plus the stack's boot, with the
  pre-bundle on disk.
