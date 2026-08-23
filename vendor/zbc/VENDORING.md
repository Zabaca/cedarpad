# vendor/zbc — NEVER EDITED HERE

This directory is a git subtree of **`Zabaca/zbc-core`**, pinned at
**`zbc-core-v0.12.0`**. It is the zbc engine's built-in modules, and it is
**not this repo's code**.

**Do not change a file in this directory.** An edit here is a fork nobody
declared, and it is invisible: the next `git subtree pull` either silently
overwrites it or conflicts on a file whose local history is one commit saying
"fix". Four repositories on this box converge machines with these modules, so a
local fix is a fix exactly one of them gets.

## Changing something in here

1. Author it in `/home/uptown/repos/zbc` — the monorepo where zbc is developed.
2. Push it there.
3. Release it as a `zbc-core-v*` tag on `Zabaca/zbc-core`, the distribution
   mirror of that monorepo's `packages/cli/templates/infra`.
4. Pull it back:

       git subtree pull --prefix=vendor/zbc \
         git@github.com:Zabaca/zbc-core.git <tag> --squash

**Never mix `vendor/zbc/` and other paths in one commit** — foundry's ADR-0007,
which holds here for the same reason: a subtree pull has to be able to find its
own history.

## The tag above is half of one number

The other half is `@zabaca/zbc` in the root `package.json`. **The subtree is the
modules an instance imports; the package is the engine that discovers and
converges them, and they must move together.** Pull one without bumping the
other and this repo runs an engine against modules it was never released with.

That is not left to whoever remembers. `bun run apply` runs
`packages/infra/check-zbc-pin.ts` first and refuses when the two disagree — so
**bumping this tag means bumping that version in the same change**, and an apply
is what tells you if you forgot. Read that file's header for why the check lives
in the apply script rather than in a test.
