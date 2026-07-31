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
1. preflight    every gate green, or stop
2. range        <last tag>..HEAD → commits + PR bodies
3. draft        classify, propose the bump, write entries in product voice
4. ── GATE ──   the human reviews and edits            ← the only human gate
5. commit       CHANGELOG.md + version bump → push to main
6. deploy       deploy.sh (stamps buildRev AND version into the image)
7. verify       deploy.sh polls /api/buildrev for BOTH stamps
8. tag          ONLY after 7 passes
9. publish      zbc apply production www → check cedarpad.com/changelog
```

**Never tag before step 7.** Tagging first mints tags for code that never shipped. Tagging after
makes `git tag` a ledger of what actually served — so a failed deploy costs nothing, the same
version number is reused, and `v0.2.0` points at exactly the SHA `/api/buildrev` returns.

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

`packages/www`'s test is the changelog guard — it parses the committed `CHANGELOG.md` and throws
on a malformed entry. It is the only thing standing between a format slip and content silently
missing from the public page.

**Never `bun test` bare** in `packages/canvas` — it collects `web-poc`'s vitest specs under the
wrong runner and produces ~10 fake failures. Use the package scripts (CLAUDE.md).

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

**Propose the bump** from the classification: any new user-visible capability → **minor**
(`0.y.0`); fixes and internal work only → **patch** (`0.0.z`). Reserve **major** for a breaking
change to the MCP tools or `/v1` — the one contract anyone integrates against, and one whose
consumers are agents that fail silently. Call such a break out in its own entry.

**Write for the person using cedarpad**, not the person who wrote the code:

- ✅ "Components no longer vanish after a restart."
- ❌ "fix materialize sibling walk in components.ts"

Keep the `(#393)` reference on the entry — it stays in `CHANGELOG.md` for traceability and is
stripped from the public page (the repo is private; the link would 404).

## 4. The gate

Present the drafted entry **and** the proposed version, in full, and wait. This is the only
human gate in the flow, so it carries the whole review: wording, classification, and the bump.
Iterate until approved.

## 5. Commit and push

Prepend the release under the `<!-- Releases below` marker in `CHANGELOG.md` — newest first:

```markdown
## [0.2.0] — 2026-07-31

### Added
- **Thing** — what it does for you. (#393)
```

Date is today, UTC: `date -u +%F`. Then set the same version in the **root** `package.json`
(one product version; the `packages/*` stay `0.0.1` and private), commit, and push to main.

`deploy.sh` refuses an unpushed HEAD, so the push is not optional.

## 6–7. Deploy and verify

```bash
bash packages/canvas/scripts/deploy.sh     # run in the BACKGROUND — 10–15 min
```

It stamps both `server/build-rev.txt` and `server/version.txt`, migrates D1, builds and pushes
both container images, waits out the two rollout settle stages, and polls `/api/buildrev` until
it serves **both** the new SHA and the new version. Success prints `✅ LIVE: v0.2.0 (abc1234)`.

**If it fails, do not bump the version again.** Fix forward and re-run — the same version number
is reused, and nothing was tagged. Two traps the script's own comments record:

- **Never re-run a deploy while a rollout is still progressing.** A re-run *replaces* the healthy
  in-flight rollout. If it says `PROGRESSING`, wait; that is not a failure.
- A `STALE` stored image is the 2026-07-28 incident (serving instances correct, stored config
  stale → every later cold boot wedges). Investigate by hand; do not blindly re-run.

## 8. Tag

Only now, and only on `✅ LIVE`:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

## 9. Publish the public changelog

```bash
bunx @zabaca/zbc apply production www          # from the REPO ROOT, as deploy.sh runs it
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

- **Never tag before the live check** — see the top of this file.
- **Never bump the version because a deploy failed.** The number belongs to the content, not to
  the attempt.
- **Never edit or delete a past release entry.** Forward-fix with a new one, like migrations.
- **Never hand-edit a `.sql` file** under `lib/db/migrations/` or `meta/_journal.json` — drizzle
  owns those, and a release migrates D1.
- **Never print secrets.** `deploy.sh` reads production credentials through
  `sops exec-env packages/infra/environments/production/secrets.yaml`; keep it that way.
- **Never file this as a GitHub issue or a Fredrin ticket.** A release is an act, not work to
  track (`docs/agents/issue-tracker.md`).
