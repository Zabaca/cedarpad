---
name: release
description: Cut a cedarpad release — draft the changelog from the diff, bump the version, deploy, verify it live, then tag and publish the public changelog. Use when asked to release, ship, cut a version, or deploy to production. Implements ADR-0025 (a release IS a deploy).
user-invocable: true
---

# Release (cedarpad)

**A release is a deploy** ([ADR-0025](../../../docs/adr/0025-a-release-is-a-deploy.md)). There is
no separate "ship it later" step: this bumps the version, deploys it, proves it is serving, and
only then tags it and publishes the public changelog.

Read the ADR before deviating from anything below — it carries the rejected alternatives.

## The order is not negotiable

```
1. preflight    CI green on HEAD, or stop
2. range        <last tag>..HEAD → commits + PR bodies
3. draft        classify, propose the bump, write entries in product voice
4. commit       CHANGELOG.md + version bump → push to main
5. deploy       deploy.sh (stamps buildRev AND version into the image)
   +             bun run deploy:sandbox (the default workspace's sbx sandbox, same commit)
6. verify       deploy-sandbox.sh reads the stamps inside the sandbox (its "ok:" line)
7. tag          ONLY after deploy.sh succeeded AND the sandbox's "ok:" line printed
8. publish      bun run apply production www → check cedarpad.com/changelog
   later         /api/buildrev serves BOTH stamps once someone has visited the workspace
```

**Never tag before step 6.** Tagging first mints tags for code that never shipped. Tagging after
makes `git tag` a ledger of what actually served — so a failed deploy costs nothing, the same
version number is reused, and `v0.2.0` points at exactly the SHA `/api/buildrev` returns.

**The workspace sandbox is inside that rule, not appended after it.** `fb2525a` made the
workspace on our own hardware the DEFAULT workspace (a VM then, an sbx sandbox since 2026-11-09,
[ADR-0028](../../../docs/adr/0028-the-default-workspace-runs-in-an-sbx-sandbox.md)), so a tag with
the Worker live and the sandbox stale would claim a version most users are not getting. `www` is
the opposite case and stays after the tag: the public page must never advertise a version that
is not serving. Deploy targets go before the tag when the tag would over-claim, and after it when
the page would.

**This buys a failure mode, deliberately: a release fails when the sandbox site (sbx on
ryzen-9) is unreachable.** That is the price of the default workspace being covered by the tag,
and it is cheaper than the alternative: a tag that silently means "the Worker, and whatever the
sandbox happened to be running".

---

## 1. Preflight

**CI runs e2e only.** `.github/workflows/e2e.yml` is the sole workflow and its sole step is
`bun run test:e2e` — unit tests, typechecks, and www's tests never run there. So this preflight
is the real gate, not a formality. Run all of it:

```bash
git status --porcelain                       # must be empty
git fetch -q origin main
git rev-list --left-right --count origin/main...HEAD   # must be 0  0
gh run list --branch main --workflow e2e --limit 1 --json headSha,conclusion  # green, on HEAD

cd packages/canvas && bun run test && bun run typecheck && bun run webpoc:typecheck && bun run webpoc:test
cd ../www && bun run test && bun run typecheck && bun run lint
```

**Those commands now run in CI, per commit, and this step only reads the result.**
`.github/workflows/gates.yml` runs the canvas and www gates on every push and PR;
`e2e.yml` runs the browser suite. Both must be green **on HEAD**:

```bash
gh run list --branch main --workflow gates --limit 1 --json headSha,conclusion
gh run list --branch main --workflow e2e   --limit 1 --json headSha,conclusion
```

Running them locally is still fine and still faster to debug, but it is no longer
what makes this step pass — a green local run on a tree CI has never seen proves
nothing about what is being tagged.

**Why this moved.** Until 2026-08-24 `e2e.yml` was the only workflow, so the unit
tests, typechecks and lint ran for the FIRST time here — against every commit since
the last tag, typically 10–18 of them across four or five days. Everything that had
broken in that window surfaced at once, at the moment someone was trying to ship. It
is the direct cause of releases taking days, and of no product change shipping
between v0.2.4 and v0.2.6.

`packages/www`'s test is the changelog guard — it parses the committed `CHANGELOG.md`
and throws on a malformed entry. With the human gate gone (see step 3) it is the only
thing that reads an entry before it reaches the public page, so a red there is never
a formatting nit.

Any gate red → **stop and report**. Do not release around a failure.

## 2. The range

```bash
git describe --tags --abbrev=0        # last release; fails if none → this is the first
git log --format='%H %s' <last-tag>..HEAD
```

No commits since the last tag → nothing to release; say so and stop.

**First release**: no tag exists, so the range is all history. Cut it as **v0.1.0** — it carries
the entire product, and `0.0.1` undersells that.

## 3. Draft

For each commit carrying a PR number, read the PR — it is where the user-facing intent lives:

```bash
gh pr view <N> --json title,body
```

**Classify every commit.** The commit prefixes are *area scopes*, not change types (`canvas:`,
`records:`, `inbox:`), so nothing in the subject line tells you whether a change is user-visible.
Decide from the PR body and the diff:

| Goes in | What |
| --- | --- |
| `### Added` / `### Changed` / `### Fixed` / `### Removed` / `### Security` | anything a person *using* cedarpad could notice |
| `### Internal` | refactors, CI, tests, docs, deploy plumbing |

Those six headings are the entire allowed set — the parser rejects anything else.

**Propose the bump** from the classification:

| Bump | When |
| --- | --- |
| **patch** (`0.0.z`) | changes to something that already exists, however substantial — plus removals, fixes, and internal work |
| **minor** (`0.y.0`) | a genuinely NEW capability: a new component, a new surface, something the product could not do at all before |
| **major** | nothing, for now. See below. |

**The line is new-thing vs better-thing, not big vs small.** Teaching an existing component
to pan, zoom, drag and highlight is a patch — the diagram card already existed and the
release made it better. That is a large diff and a small version bump, and it is meant to be:
the number says what KIND of change shipped, not how much work it took. Ask "could someone do
this before?", not "how much changed?".

**Removals are patches too, for now,** even when they break something already on a board.
v0.4.0 retired ten built-in components and any card placed from one stopped loading — still a
patch. Pre-1.0 nothing here is stable, and pretending otherwise with the version number would
be a promise the project is not making yet. Say plainly what broke, in `### Removed`, and let
the entry carry the warning instead of the number.

**Major is reserved and currently unreachable.** Until `1.0`, nothing is stable, so no release
earns one. After `1.0`, breaking changes go here — most sharply a break to the MCP tools or
`/v1`, the one contract anyone integrates against, and one whose consumers are agents that fail
silently. Call such a break out in its own entry.

**There is no approval gate after this — write the entry and carry on to step 4.**
It used to stop here and wait, and that is what made a release need a human present in
the middle of it rather than at the end: the draft is prose about work that has already
merged, and holding a deploy on it bought review of the wording and nothing else. The
CHANGELOG stays editable afterwards; a tag names a commit that provably served, and
correcting an entry later does not disturb that. What is NOT editable later is the
version bump, so if the classification is genuinely ambiguous — a change that might be
a minor rather than a patch — say which you chose and why in the release report.

**Write for the person using cedarpad**, not the person who wrote the code:

- ✅ "Components no longer vanish after a restart."
- ❌ "fix materialize sibling walk in components.ts"

Keep the `(#393)` reference on the entry — it stays in `CHANGELOG.md` for traceability and is
stripped from the public page (the repo is private; the link would 404).

## 4. Commit and push

Prepend the release under the `<!-- Releases below` marker in `CHANGELOG.md` — newest first:

```markdown
## [0.2.0] — 2026-07-31

### Added
- **Thing** — what it does for you. (#393)
```

Date is today, UTC: `date -u +%F`. Then set the same version in the **root** `package.json`
(one product version; the `packages/*` stay `0.0.1` and private), commit, and push to main.

`deploy.sh` refuses an unpushed HEAD, so the push is not optional.

## 5–6. Deploy and verify

```bash
bash packages/canvas/scripts/deploy.sh     # run in the BACKGROUND — the image build takes minutes
```

It stamps both `server/build-rev.txt` and `server/version.txt`, migrates D1, and runs
`bun run apply production canvas` (Shell build, Worker + container image, secrets). There are no
container rollouts to wait for (ADR-0027: each workspace's `CanvasContainer` takes a new image on
its next request). Since `default` is self-hosted it does not poll `/api/buildrev`: it prints
`deployed v… (…)`, says the default workspace is self-hosted, and stops. The sandbox step below
is what proves the workspace.

**If it fails, do not bump the version again.** Fix forward and re-run — the same version number
is reused, and nothing was tagged. A re-run is always safe: there is no in-flight rollout for it
to replace.

## 5–6 (the sandbox). Ship the workspace and read its stamps back

Run it after `deploy.sh` reports `deployed`, not beside it: the two share nothing at
runtime, and serialising keeps one failure legible instead of two interleaved. **From James's
Mac**: sbx's credentials and the build machine's identity are there.

```bash
bun run deploy:sandbox          # packages/canvas/scripts/deploy-sandbox.sh, from the REPO ROOT
```

It archives `origin/main`, builds the image on the site's build machine with the commit and
version as build arguments (the same two stamps `deploy.sh` writes into the container image,
for the same reason: ADR-0025), replaces the sandbox's image (it creates the sandbox the first
time), and then **reads the stamps inside the sandbox**. Its last line is the proof:

```
ok: cedarpad-default is on abc1234 (v0.2.0); the next request to the workspace boots the stack on it
```

Both must match what step 4 pushed; the script fails otherwise. That line is the sandbox's own
stamp check, the equivalent of reading the VM's stamps used to be, and needs no credentials
beyond the Mac's. After a replace the stack is down (the pod starts fresh from the new image);
the next request boots it on the new code.

**The gate for the tag is `deploy.sh` succeeding plus that `ok:` line.** Neither needs a person
to visit the workspace, so a release never waits on one.

**`/api/buildrev` is the check that follows the next visit, not a gate.** The route is public and
PASSIVE: it never wakes the sandbox and never boots its stack, so it answers 503 while the
sandbox sleeps or its stack is down. A 503 means nobody has opened the workspace since the
deploy, not that the deploy failed, and the release must not wake it to make it answer. After
the next visit (James's, or any signed-in one), read it:

```bash
curl -s https://app.cedarpad.com/api/buildrev     # {"buildRev":"abc1234","version":"0.2.0"}
```

Both fields must be what step 4 pushed. A different SHA or version means the sandbox is not on
this release: investigate, and say so in the report. Report this check as pending when no visit
has happened yet.

**If the sandbox deploy fails, do not tag.** Fix forward and re-run: same version number,
nothing tagged. The script is safe to re-run (a replace keeps the sandbox's name, address,
environment and allow-list). `--dry-run` shows what it would do and changes nothing.

**Requires sbx and its credentials on the Mac** (`sbx` on PATH, or Home's checkout; sops with
this Mac's age key). The script says what is missing.

## 7. Tag

Only now: `deploy.sh` printed `✅ deployed` and `deploy-sandbox.sh` printed its `ok:` line.

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## 8. Publish the public changelog

```bash
bun run apply production www          # from the REPO ROOT, as deploy.sh runs it
curl -sL https://cedarpad.com/changelog | grep -o 'v0\.2\.0'
```

**`-L` is not optional.** Astro emits `changelog/index.html`, so `/changelog` answers **307 →
`/changelog/`**. Without it curl reports a 404 body on a page that is live and correct — which
is exactly what happened on the v0.0.1 release, and briefly looked like a failed deploy.

www is a **separate** deploy and can fail independently. It runs last so the public page can
never advertise a version that is not serving. A www failure leaves a live, tagged release with a
lagging page — recoverable by re-running this step alone, not by redoing the release.

## Report

State what is live (version + SHA), what the changelog says, and anything skipped. If a step was
not run, say so — do not imply a green path that was not walked.

---

## Never

- **Never tag before step 6** (`deploy.sh` succeeded and the sandbox's `ok:` line printed), see the top of this file.
- **Never bump the version because a deploy failed.** The number belongs to the content, not to
  the attempt.
- **Never rewrite what shipped when.** A released entry is a record of one artifact, so never
  move an item to a different version, restate a claim the release did not make, or delete
  history. **But an entry that misdescribes its OWN release is corrected in place** — that is
  what serves the same purpose. On v0.0.1 three live capabilities (Huddles, the dev agent,
  marts) were omitted because the docs read as unshipped; filing them under `0.0.2` would have
  told readers they arrived a day later than they did. Correcting an omission is not rewriting
  history; it is the opposite. Migrations are not the right analogy — those change state, an
  entry only describes it.
- **Never hand-edit a `.sql` file** under `lib/db/migrations/` or `meta/_journal.json` — drizzle
  owns those, and a release migrates D1.
- **Never print secrets.** `deploy.sh` reads production credentials through
  `sops exec-env packages/infra/environments/production/secrets.yaml`; keep it that way.
- **Never file this as a GitHub issue or a Fredrin ticket.** A release is an act, not work to
  track (`docs/agents/issue-tracker.md`).
- **Never skip `bun run deploy:sandbox` because "nobody is on the canvas right now".** It is the
  default workspace, so the next person to open one gets whatever image was left there, and the
  tag will already have claimed otherwise. An unreachable sandbox site stops the release; it does
  not make the step optional.
- **Never wake the sandbox to make `/api/buildrev` answer.** The route is passive on purpose (an
  anonymous poll would keep the sandbox awake for good); a 503 there means "not visited yet". The
  stamp check inside `deploy-sandbox.sh` is the proof that needs no visit.
- **Never make the tag wait for a visit.** `/api/buildrev` is read after the next visit and is
  reported as pending until then; the sandbox's own stamp check is the gate.
