# pty-server — the Console's PTY host (ADR-0021)

Serves the **Console**: one real PTY per workspace container, reached over a WebSocket.
See [ADR-0021](../../../docs/adr/0021-the-console-is-an-operator-surface.md) for the design
and [canvas CONTEXT.md](../CONTEXT.md) for the vocabulary.

## Why this is an island, and not part of the canvas package

Two hard constraints, both **measured** (2026-07-29), not assumed. Neither is a preference,
so please do not "tidy" this back into the workspace.

### 1. It runs under `node`, never `bun`

`node-pty` is completely non-functional under bun — not merely resize-broken. The PTY
spawns and an fd is allocated, but zero bytes ever flow, writes silently no-op, and
`resize()` throws `ioctl(2) failed, EBADF`. Reproduced across bun 1.3.5 and 1.3.12, on
darwin-arm64 and linux-amd64. Under node it works everywhere.

That matters because SIGWINCH is the whole point: the Sandbox SDK's built-in `Bun.Terminal`
drops it, so Claude's TUI never reflows on resize. A real `TIOCSWINSZ` is why node-pty is
here at all, so a runtime that can't deliver it is not an option.

### 2. It is installed with `npm`, never `bun install`

`bun install` does not run node-pty's `install`/`postinstall` lifecycle scripts — **even
with `trustedDependencies` set and `--force` passed**. The result is a package that looks
installed but isn't:

- no `build/Release/` (on Linux there is no prebuild at all, so there is no native module
  whatsoever — node-pty ships prebuilds only for darwin-x64/arm64 and win32-x64/arm64), and
- the shipped `spawn-helper` lands **without its execute bit**, which surfaces at spawn time
  as a misleading `posix_spawnp failed`.

That error looks exactly like a bun/node-pty incompatibility and is not — plain `node` fails
identically against a bun-installed tree. Two separate defects; don't conflate them.

Keeping this directory outside the bun workspace is what lets `npm install` own it without
fighting the root lockfile.

## Building it

Linux needs a C++ toolchain, because there is no linux prebuild:

```sh
apt-get install -y python3 make g++   # already in the container image
cd pty-server && npm install          # runs node-gyp, emits build/Release/pty.node
```

## Wire protocol

Framing is by **frame type**, so control and keystrokes can never be confused (the ceo POC
sniffed a leading `{`, which a pasted JSON payload would trip):

| Direction | Binary frame | Text frame |
| --- | --- | --- |
| server → client | raw PTY output | JSON control (`superseded`, `exit`) |
| client → server | keystrokes | JSON control (`resize`) |

## Ports

`CANVAS_PTY_PORT`, never hardcoded (CLAUDE.md guideline 6 — worktree-safe by default).
