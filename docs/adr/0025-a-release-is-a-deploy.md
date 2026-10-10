# A release is a deploy, versioned and tagged only once it is live

Status: **accepted** (grill session 2026-07-31). The verify step is amended by
[ADR-0027](./0027-workspace-containers-run-on-the-durable-object-policy.md): while `default`
is self-hosted, `/api/buildrev` reports the VM and `deploy:vm` is what proves it. Vocabulary: root
[CONTEXT.md](../../CONTEXT.md) — **Workspace**, **App**; canvas
[CONTEXT.md](../../packages/canvas/CONTEXT.md); www
[CONTEXT.md](../../packages/www/CONTEXT.md).

Cedarpad has shipped for months with no version at all. No git tags, no changelog, every
package pinned at `0.0.1` and `private`. The only thing identifying what is running is
`buildRev` — a short git SHA baked into the container image (`server/build-rev.txt`), served
at `/api/buildrev`, and never shown to a user. It exists so `deploy.sh` can prove a rollout
is live, and it is very good at that. It is not something you can tell anyone about.

**A release is a deploy.** `deploy.sh` is already a deliberate, manual act — there is no
deploy-on-push workflow, only `e2e.yml`, which tests. So this does not introduce a pipeline;
it attaches a version, a changelog, and a tag to a thing that already happens.

## The order is the design

Three requirements interlock. The version must be **baked into the image** (so the API and
the app can report it), **drafted from the diff** (so it is written after the commits exist),
and **tagged**. Exactly one ordering satisfies all three:

```
preflight   clean tree · HEAD == origin/main · e2e green on HEAD
range       <last tag>..HEAD → commits + PR bodies
draft       classify user-visible vs internal, propose the bump, write entries
── gate ──  a human reviews and edits            ← the only human gate
commit      CHANGELOG.md + version bump → push to main
deploy      deploy.sh stamps buildRev AND version into the image
verify      /api/buildrev reports the new SHA *and* the new version
tag         only now: git tag v0.2.0 && git push --tags
publish     zbc apply production www
```

**Tagging last is the load-bearing decision.** The obvious order — tag, then deploy — mints
tags for code that never shipped, and every failed deploy either burns a version number or
leaves a lying tag behind. Tagging on verified-live makes `git tag` a ledger of what
**actually served**: a failed deploy costs nothing, the same version number is reused, and
`v0.2.0` points at precisely the SHA `/api/buildrev` returns. Version and artifact are 1:1
and the binding is checkable at runtime, not bookkeeping.

Publishing to www last falls out of the same rule: the public changelog can never advertise a
version that is not serving, because it is only built after the live check passes.

## One product version, not four

The root `package.json` carries the version. The four `packages/*` stay at `0.0.1` and
`private`.

A release ships **one Cloudflare instance** — canvas, the Notebook, and the shell in a single
image (ADR-0018). Bumping four never-published packages in lockstep would be ceremony
describing a boundary that does not exist at deploy time. `deploy.sh` stamps
`server/version.txt` beside the `build-rev.txt` it already writes, so the version reaches the
image through a mechanism that is already proven in production.

www is versioned by nothing and deployed separately, as it always has been. It is a
marketing site that happens to render the changelog; it is not part of the artifact the
version names.

## The changelog is drafted, not accumulated

The commit stream cannot answer "is this user-visible?". Measured over the last 150 commits,
the subject prefixes are **area scopes, not change types**:

```
51 canvas:   20 docs:   12 records:   7 inbox:   6 worker:   ...   3 feat:   1 chore:
```

`canvas:` covers both "Ilograph diagrams ship" and "rename a helper". So
`conventional-changelog` is not merely unadopted here — adopting it would mean rewriting a
convention that is genuinely useful (it says *where*, which is what a reader of this repo's
history wants) in order to say *what kind*, and it would still emit developer prose into a
user-facing document.

**Changesets were the serious alternative**: a markdown fragment per user-visible PR,
collected at release. It is accurate by construction. It was rejected because it taxes every
PR and decays — the discipline holds until the week it does not, and a changelog with silent
gaps is worse than none.

Instead the release skill reads `<last tag>..HEAD` plus the PR bodies (85 of the last 120
commits carry a PR number), classifies each change, and drafts entries in product voice for a
human to edit. This is guideline 5 applied to documentation: the expensive part of a
changelog was always the writing, and that is the part that got cheap. The bottleneck becomes
one review gate per release rather than authorship spread across every merge.

## Semver, when nobody installs you

Versions start at `0.x`, where semver's own rule is "anything may change". The working
convention:

- **patch** (`0.0.z`) — fixes and internal work; nothing a user would notice.
- **minor** (`0.y.0`) — any new user-visible capability.
- **major** — reserved for a breaking change to **the MCP tools and `/v1`**.

That last line is why semver rather than CalVer or a monotonic release number. Nothing
installs cedarpad, so for the app itself the number is pure communication and any scheme
would do. But the MCP tool surface and the Notebook's `/v1` contract are integrated against
by agents, which fail *silently* on a break. That is the one place a version can carry a
compatibility promise, so the scheme is chosen to be able to make it, and breaks there get
their own changelog section.

## Public and internal are one file, two renderings

Every deploy mints a version, but some deploys have nothing to say — the 2026-07-30 release
carried four docs-only commits. `CHANGELOG.md` records **every** version, including an
`### Internal` section. `cedarpad.com/changelog` renders everything except that section, and
omits a version entirely when internal work is all it contains.

This keeps one source of truth while neither lying about what shipped nor filling a public
page with e2e coverage notes. The format is a contract between the release skill and the www
build, and markdown drift is silent — the public page would just quietly lose a section — so
www carries a test that parses the committed `CHANGELOG.md` and fails on a malformed entry.

**The changelog is served from www, not the app.** Serving it from the container was a real
contender: it ships *inside* the artifact it describes, so it cannot drift from what is
running, and it needs no second deploy. It loses because `app.cedarpad.com` is behind the
Better Auth gate (ADR-0020) — a changelog there is invisible to everyone who has not signed
in, which is most of the audience for one.

## Consequences

**`/api/buildrev` grows a second field.** Its comment records that the public surface is
"exactly one non-sensitive field", sized against a security review. It becomes two. A version
number reveals strictly less than the git SHA already there, so the risk does not change — but
this is a deliberate amendment to a reviewed decision, and the comment moves with it.

**The deploy gains a preflight it did not have.** `deploy.sh` checks that HEAD is clean and
published; it does not check that CI passed. A release does, because a tag is a claim.

**Every deploy now costs a changelog.** A one-line urgent fix becomes `0.0.z+1` with an
entry. This is accepted: the entry can be one line under `### Fixed`, and the alternative —
unversioned "quick" deploys — reintroduces exactly the ambiguity about what is live that this
ADR exists to remove.

**A release is two deploys.** canvas, then www. They can fail independently, and the ordering
above means a canvas failure stops the release before www is touched. A www failure leaves a
live, tagged version whose public page lags — recoverable by re-running the publish step
alone.
