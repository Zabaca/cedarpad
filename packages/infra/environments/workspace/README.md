# workspace — the cedarpad canvas Guest on ryzen-9

The eight declarations that describe `ws.cedarpad.com`: an incus KVM guest on
ryzen-9, its toolchain, the checkout and unit that run the canvas, and the
Cloudflare tunnel and Access policy that put it on the internet. They lived in
the foundry repo until 2026-08-19 and moved here under foundry's
[ADR-0026](https://github.com/Zabaca/zbc) — *a guest is converged by the repo
that owns it*.

## Why they were ever somewhere else

incus listened on a local unix socket only, so the only machine that could
converge a guest was ryzen-9 itself, and the only repo that ran there was
foundry. That is a fact about a socket, not about ownership: six of these eight
were always cedarpad's concern. `ws-provision` was literally a second,
hand-maintained copy of `packages/canvas/Dockerfile`, and its own header said
the two could drift silently. Here they sit in one repo.

## What makes it work from here

`target: { remote: 'ryzen-9', project: 'zabaca' }` on `ws.ts`. The other seven
inherit it. `ryzen-9` is an incus remote this repo's operator adds once:

```
# on the machine that will run the apply, asked for from foundry:
#   bun run incus-enrol cedarpad      → prints a single-use token, 1h expiry
incus remote add ryzen-9 <token>
```

The client generates its own keypair locally, so no key is handed over. The
certificate is scoped to the `zabaca` project and nothing else on that daemon is
reachable with it — foundry's own guests live in `default`, out of reach.

## Applying

```
bun run apply workspace          # all eight
bun run apply workspace ws       # the guest alone
```

**`bun run apply`, not a bare `zbc`.** There is no `zbc` on any PATH here; the
CLI is a devDependency and `bun run` is what puts it on one. This file said
`zbc apply …` until 2026-08-23 and that command had never worked on this box —
which is worse than saying nothing, because it stops the reader looking for the
one that does. A migration found it by trying.

**The CLI version is pinned to the vendored tag and the two must move together.**
`vendor/zbc/` is a git subtree of `Zabaca/zbc-core` at **`zbc-core-v0.12.0`**,
and `@zabaca/zbc` in the root `package.json` is `0.12.0`. The subtree is the
modules an instance imports; the package is the engine that discovers and
converges them. Pull one without bumping the other and you are running an engine
against modules it was not released with. Nothing enforces this — it is two
numbers in two files, and this paragraph is the only thing that says they are
one number.

A third environment rather than part of `production`, deliberately: an apply of
production must not require ryzen-9 to be reachable, and the release path's
`bun run apply production www` would otherwise sweep a VM converge into every
page deploy.

## Secrets

`secrets.yaml` here holds `WS_SUPERVISOR_TOKEN`, the bearer the supervisor's
control plane checks. It is encrypted to this repo's four recipients plus
ryzen-9's own key, which is the operator that applies this environment today.

**`ws-token.ts` needs `CLOUDFLARE_ROOT_TOKEN` and this file does not carry it.**
It mints a scoped, per-apply-rolled Cloudflare token for the tunnel and the
Access policy, from an account-level credential that can create API tokens. That
credential is foundry's, and putting a copy here widens who holds the account
root — a decision for whoever owns the Cloudflare account, not for the change
that moved these files. Two ways to close it, both fine:

1. **Add `CLOUDFLARE_ROOT_TOKEN` to this file.** Keeps the per-apply rolling the
   current design buys.
2. **Mint one long-lived scoped token by hand** — Tunnel Write, Zone Read,
   Access Apps and Policies Write, Access Service Tokens Write, DNS Write —
   store it here, and delete `ws-token.ts`, pointing `ws-tunnel` and `ws-access`
   at the secret directly. Narrower blast radius, no rolling.

Until then `bun run apply workspace ws`, `ws-provision`, `ws-app` and
`ws-service` converge; the tunnel, its token, the Access policy and the in-guest cloudflared
do not.
