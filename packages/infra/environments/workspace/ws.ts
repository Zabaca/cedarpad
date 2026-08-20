import { vmModule } from '../../../../vendor/zbc/modules/vm'

// The guest that hosts a cedarpad canvas workspace — vite + the bridge + a
// Claude Code agent, long-lived, in place of a Cloudflare Container.
//
// A full KVM VM, not a system container, and deliberately NOT on the semi-
// trusted footing ADR-0004 chose for agent sessions. Two things put this on the
// untrusted side of that ADR's own dividing line: the canvas runs agent-AUTHORED
// components (code no human reviewed), and it is reachable by share-link guests
// who hold no account here. ADR-0004's I/O argument for containers — small-file
// toolchain churn — is an argument about SESSIONS, which are created and
// destroyed constantly and pay a fresh clone plus install each time. This guest
// installs once and lives for months, so it pays that cost one time and keeps
// the stronger boundary for free.
//
// Sizing. Cloudflare gives the equivalent container 1/2 vCPU and 4 GiB; the
// starvation that causes is a large part of why cold boots there take 30-120s.
// 8 cpu is the actual upgrade being bought. 12GiB is a CEILING, not a
// reservation — qemu faults pages in lazily (measured on agent-vm: 8GiB
// configured, 0.96 GiB resident), so an idle guest costs the host almost
// nothing and the number only has to be big enough for vite's tldraw
// pre-bundle plus a `bun install` peak. Elastic upward, sticky downward: the
// guest will not hand page cache back, so treat this as the high-water mark it
// will eventually sit at.
//
// 40GiB disk: node_modules for the whole cedarpad workspace, vite's `.vite`
// pre-bundle cache, the per-workspace repo checkouts the bridge maintains under
// `.repos`, and session transcripts. All create-time, all frozen here.
//
// incusbr0, not agent-br0: this guest holds real credentials and needs ordinary
// egress to R2, api.anthropic.com and app.cedarpad.com. agent-br0 has no route
// out except the credential broker, and teaching that broker to swap R2's SigV4
// signature (a signed request, not a substitutable header) is its own piece of
// work. Moving here is the follow-up, not the spike.
//
// Create-time only: cloud-init runs once, on first boot. Everything that should
// re-converge on later applies lives in cedarpad-ws-provision.ts.
//
// **The docker-forward dependency did not come with this declaration, and that
// is the shape of the boundary rather than an omission.** Without those
// DOCKER-USER rules a guest on this host gets a DHCP lease and no route off the
// box, and cloud-init dies on its first apt-get — but the rules belong to the
// host's own networking, which foundry declares and applies. What used to be an
// `imports:` edge guaranteeing order is now an assumption about the substrate,
// held by the repo that owns the machine. That is exactly the trade ADR-0026
// makes: an Owner repo declares its guest, not the box under it.
export default vmModule.instance({
  name: 'ws',
  config: {
    name: 'cedarpad-ws',
    type: 'virtual-machine',
    cpu: 8,
    memory: '12GiB',
    disk: '40GiB',
    sshUser: 'foundry',
    // ryzen-9's own key plus every key that already reaches ryzen-9, matching
    // agent-vm: the host provisions this guest over ssh on every apply.
    authorizedKeyFiles: ['~/.ssh/id_ed25519.pub', '~/.ssh/authorized_keys'],
    // The incus project this guest lives in, moved out of `default` by hand on
    // 2026-08-18 under ADR-0026's migration plan — stop, `incus move
    // --target-project zabaca`, start; six seconds of guest downtime.
    //
    // **`remote` is what changed when this declaration moved here.** It names
    // the daemon the command is sent to, and its presence is what drops the
    // `sudo` a local root-owned socket needs: a remote endpoint is mTLS and
    // authenticates as whoever holds the client certificate, so `incus-core`
    // renders `incus --project zabaca ryzen-9:cedarpad-ws` and runs it as an
    // ordinary user. `ryzen-9` is a remote this repo's operator adds once, with
    // a single-use token foundry issues (`bun run incus-enrol cedarpad`); the
    // client generates its own keypair, so no key is ever handed over.
    //
    // It has to be here rather than left implicit, because `vm`'s apply finds
    // an existing guest through this target — a declaration naming the wrong
    // project would find nothing and build a second, empty `cedarpad-ws`
    // beside the running one. The module now refuses that rather than doing
    // it, but the declaration agreeing with the machine is the actual repair.
    //
    // The four vm-provision instances that import this one inherit the target
    // from these outputs rather than restating it, exactly as they inherit
    // `sshUser`.
    target: { remote: 'ryzen-9', project: 'zabaca' },
    // ADR-0026: every guest on that box names the repo that converges it, read
    // off the daemon by foundry's `ryzen-9-live-guest-owners.test.ts`, which
    // fails on a guest carrying none. This one is ours now, and flipping this
    // string from `foundry` is the moment the ownership actually moves — the
    // label is the machine's own answer to "who declares this", not a note in
    // either repo.
    incusConfig: { 'user.owner': 'cedarpad' },
  },
})
