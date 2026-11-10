# Third-party notices

cedarpad's own code is under [`LICENSE`](LICENSE). The rest keeps its own licence.

## tldraw

The canvas is built on [tldraw](https://tldraw.dev) (`tldraw`, `@tldraw/sync` and `@tldraw/sync-core`, version
5.2.5), which is copyrighted by tldraw, Inc. and used under
[tldraw's licence](https://github.com/tldraw/tldraw/blob/main/LICENSE.md), not under cedarpad's. As of 2026-11-09 that
licence permits use in a development environment and requires a trial or a commercial licence key for a production
deployment, forbids changing its licence-key checks, and may not be overridden by the terms of a project that bundles
it. No tldraw licence key is in this repository. Anyone who runs cedarpad for end users needs their own, and the
licence text that applies is the one in the `tldraw` package you install.

## zbc

`vendor/zbc` holds the built-in modules of [zbc](https://github.com/Zabaca/zbc), Zabaca's deployment tool, as a
vendored copy of `Zabaca/zbc-core` at the tag named in [`vendor/zbc/VENDORING.md`](vendor/zbc/VENDORING.md). zbc is
MIT-licensed, Copyright 2026 Zabaca.

## Agent skills

Some of the agent skills under `.agents/skills` and `.claude/skills` come from
[mattpocock/skills](https://github.com/mattpocock/skills) (the list is `skills-lock.json`), MIT-licensed, Copyright (c)
2026 Matt Pocock. The skills written for this repository, `release`, `worktree` and `cedarpad-component`, are
cedarpad's own.

## Packages from npm

The other dependencies are installed from npm under their own licences, which their packages carry. None is vendored
into this repository except as listed above.
