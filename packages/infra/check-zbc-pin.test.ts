import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { comparePin, declaredTag, declaredVersion } from './check-zbc-pin'

// The engine and the modules are ONE number written in TWO files, and nothing
// used to check that they agree.
//
// `vendor/zbc/` is a git subtree of `Zabaca/zbc-core` at a `zbc-core-v*` tag —
// the modules an instance imports. `@zabaca/zbc` in the root package.json is the
// engine that discovers those instances and converges them. Pull one without
// bumping the other and this repo runs an engine against modules it was never
// released with, and nobody typed a number so nobody notices.
//
// That was not hypothetical: until 2026-08-23 the production deploy ran
// `bunx @zabaca/zbc apply` with **no version at all**, which resolves to
// whatever is latest at the moment of the release, against a subtree pinned to
// a tag. The worst version of this problem is the one where the number is not
// written down anywhere to disagree with.
//
// ── why this is a script and not only a test ────────────────────────────────
//
// cedarpad's only CI is `e2e.yml`, which runs Playwright. There is no unit-test
// job, no turbo test pipeline and no lefthook. A guard living only in a test
// file here would be run by nobody, which is a more comfortable form of the
// problem rather than a fix. So the enforcement is wired into `bun run apply`
// itself — `"apply": "bun packages/infra/check-zbc-pin.ts && zbc apply"` — the
// same shape foundry uses to stop an apply from a worktree. Every apply in this
// repo passes through it: production, preview and workspace alike, including
// `deploy.sh`, which now calls `bun run apply` rather than an unpinned `bunx`.
//
// This file tests the comparison. The `&&` is what makes it bite.

describe('the pin is one number, and the comparison is exact', () => {
  test('agreeing files pass', () => {
    expect(comparePin({ tag: 'zbc-core-v0.12.0', version: '0.12.0' })).toEqual({ ok: true })
  })

  test('a disagreement fails and names both sides', () => {
    const result = comparePin({ tag: 'zbc-core-v0.12.0', version: '0.11.0' })
    expect(result.ok).toBe(false)
    // Both numbers, because the reader's next question is "which one is wrong",
    // and a message naming one of them cannot answer it.
    expect(result.ok === false && result.why).toContain('0.12.0')
    expect(result.ok === false && result.why).toContain('0.11.0')
  })

  test('a missing tag is a failure, not a pass', () => {
    // The dangerous default. If an absent record read as "nothing to compare",
    // deleting VENDORING.md would turn the guard off and every apply would go
    // green — which is the same failure as a Cloudflare LIST endpoint answering
    // empty for a token without the scope.
    expect(comparePin({ tag: undefined, version: '0.12.0' }).ok).toBe(false)
    expect(comparePin({ tag: 'zbc-core-v0.12.0', version: undefined }).ok).toBe(false)
    expect(comparePin({ tag: undefined, version: undefined }).ok).toBe(false)
  })

  test('a prefix match is not a match', () => {
    // `0.1` must not satisfy `0.12.0`. Comparison is on the whole version.
    expect(comparePin({ tag: 'zbc-core-v0.12.0', version: '0.1' }).ok).toBe(false)
    expect(comparePin({ tag: 'zbc-core-v0.1', version: '0.12.0' }).ok).toBe(false)
  })

  test('a range is refused rather than resolved', () => {
    // `^0.12.0` installs 0.12.x — a range is exactly the "nobody typed a number"
    // problem in a shorter form, so it fails here rather than being satisfied
    // by whatever it happens to resolve to today.
    for (const version of ['^0.12.0', '~0.12.0', '>=0.12.0', 'latest', '*']) {
      expect(comparePin({ tag: 'zbc-core-v0.12.0', version }).ok, version).toBe(false)
    }
  })
})

describe('this repo agrees with itself', () => {
  const root = join(import.meta.dir, '..', '..')

  /** Every line of every tracked .sh/.ts/.json file, with comment lines removed. */
  const executableLines = (): Array<{ file: string; line: number; text: string }> => {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const tracked = spawnSync('git', ['-C', root, 'ls-files', '*.sh', '*.ts', '*.json'], {
      encoding: 'utf8',
    }).stdout.split('\n').filter((f) => f.trim() !== '' && !f.startsWith('vendor/zbc/'))
    const out: Array<{ file: string; line: number; text: string }> = []
    for (const file of tracked) {
      let text: string
      try {
        text = readFileSync(join(root, file), 'utf8')
      } catch {
        continue
      }
      text.split('\n').forEach((raw, i) => {
        if (/^\s*(#|\/\/|\*|\/\*)/.test(raw)) return
        out.push({ file, line: i + 1, text: raw })
      })
    }
    return out
  }

  test('the tag is recorded where a reader lands', () => {
    expect(declaredTag(root)).toMatch(/^zbc-core-v\d+\.\d+\.\d+$/)
  })

  test('the version is an exact pin, not a range', () => {
    expect(declaredVersion(root)).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('and the two agree', () => {
    expect(comparePin({ tag: declaredTag(root), version: declaredVersion(root) })).toEqual({
      ok: true,
    })
  })

  test('`bun run apply` runs the check before it applies anything', () => {
    // The half that makes this real. Without the `&&` the comparison above is a
    // fact nobody consults at the moment it matters.
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.apply).toContain('check-zbc-pin')
    expect(pkg.scripts.apply).toContain('&&')
    expect(pkg.scripts.apply).toMatch(/check-zbc-pin[^&]*&&.*zbc apply/)
  })

  test('no EXECUTABLE line anywhere runs an unpinned apply', () => {
    // The search the acceptance asks to be shown, run as an assertion rather
    // than pasted into a report.
    //
    // COMMENTS ARE STRIPPED, and that is not laziness. The first spelling
    // matched the raw text and failed on `deploy.sh`'s own comment explaining
    // why the unpinned form is wrong — and on this file, and on the header of
    // the script it is testing. A guard that fires on the prose describing the
    // defect is a guard someone deletes, and RULES.md says so. What can run is
    // what matters; what a comment quotes cannot converge anything.
    // ONLY the `bunx` form, and the distinction is the whole point. `zbc apply`
    // run from `node_modules/.bin` — which is what `package.json`'s own apply
    // script does — is pinned twice over: by the exact version in
    // `devDependencies` and by the lockfile. `bunx @zabaca/zbc` with no `@x.y.z`
    // is the unpinned one, because it resolves against the registry at the
    // moment it runs. The first spelling of this flagged the repo's own correct
    // invocation.
    const offenders = executableLines().filter(({ text }) =>
      /\bbunx\s+(--\S+\s+)*@zabaca\/zbc(?!@\d)/.test(text),
    )
    expect(offenders.map((o) => `${o.file}:${o.line}`)).toEqual([])
  })

  test('the comment-stripping is not hiding a real invocation', () => {
    // The control for the test above: if stripping ate everything, the filter
    // would pass over nothing and report clean. So the corpus must be real, and
    // must contain the invocations we DO want.
    const lines = executableLines()
    expect(lines.length).toBeGreaterThan(200)
    expect(lines.some(({ text }) => text.includes('bun run apply'))).toBe(true)
  })

  test('no markdown outside the ADRs documents an unpinned apply', () => {
    // Documentation is the other half. The ADRs are excluded deliberately —
    // they record what was decided when, not what to type today — and
    // `workspace/README.md` narrates what this repo USED to say, which is the
    // one place the old string belongs.
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const grep = spawnSync('grep', ['-rn', '--include=*.md', '-e', 'zbc apply', root], {
      encoding: 'utf8',
    })
    const hits = (grep.stdout ?? '')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(`${root}/`, ''))
      .filter((l) => !l.includes('node_modules/'))
      .filter((l) => !l.startsWith('vendor/zbc/'))
      .filter((l) => !l.startsWith('docs/adr/'))
      .filter((l) => !l.startsWith('packages/infra/environments/workspace/README.md'))
      .filter((l) => !/`bun run apply/.test(l))
    expect(hits).toEqual([])
  })
})
