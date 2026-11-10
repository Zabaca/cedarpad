# Third-party notices

cedarpad's own code is under [`LICENSE`](LICENSE). The rest keeps its own licence.

## tldraw

The canvas is built on [tldraw](https://tldraw.dev) (`tldraw`, `@tldraw/sync` and `@tldraw/sync-core`, version
5.2.5), copyrighted by tldraw, Inc. and used under tldraw's own licence, not under cedarpad's. The licence text is
<https://github.com/tldraw/tldraw/blob/main/LICENSE.md>; it was read there on 2026-11-10 and has not changed since
2025-09-17. As read then, it:

- permits use in a development environment (internal hosting for development, testing or staging, not accessible to
  end users, customers or the public);
- requires a trial or a commercial licence key for any production deployment, which it defines as a deployment that
  operates on servers, cloud platforms or web applications, or provides functionality to end users, customers or
  the public;
- forbids changing or interfering with its licence-key checks, and a licence that overrides it;
- must accompany any distribution of tldraw, which the `tldraw` package you install does.

No tldraw licence key is in this repository. Anyone who runs cedarpad for end users needs their own, and the licence
that applies to you is the one at that address on the day you deploy and in the package you install.

## zbc

`vendor/zbc` holds the built-in modules of [zbc](https://github.com/Zabaca/zbc), Zabaca's deployment tool, as a
vendored copy of `Zabaca/zbc-core` at the tag named in [`vendor/zbc/VENDORING.md`](vendor/zbc/VENDORING.md). The
`zbc-core` mirror carries no licence file of its own; zbc, its source, is MIT-licensed, and its licence is reproduced
here:

```text
MIT License

Copyright (c) 2026 Zabaca

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Agent skills

The skills under `.agents/skills` (linked from `.claude/skills`) are from
[mattpocock/skills](https://github.com/mattpocock/skills), MIT-licensed. They are:
`ask-matt`, `code-review`, `codebase-design`, `design-an-interface`, `diagnosing-bugs`, `domain-modeling`, `grill-me`, `grill-with-docs`, `grilling`, `handoff`, `implement`, `improve-codebase-architecture`, `setup-matt-pocock-skills`, `tdd`, `to-spec`, `to-tickets`.
(`skills-lock.json` pins them.) Its licence is reproduced here:

```text
MIT License

Copyright (c) 2026 Matt Pocock

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The skills written for this repository, `release`, `worktree` and `cedarpad-component`, are cedarpad's own.

## Packages from npm

The other dependencies are installed from npm under their own licences, which their packages carry. None is vendored
into this repository except as listed above.
