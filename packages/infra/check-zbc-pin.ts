#!/usr/bin/env bun
// `bun run apply` refuses when the vendored modules and the engine disagree.
//
// `vendor/zbc/` is a git subtree of `Zabaca/zbc-core` at a `zbc-core-v*` tag —
// the modules an instance imports. `@zabaca/zbc` in the root package.json is the
// engine that discovers those instances, resolves their imports and converges
// them. **They are one number written in two files**, and until 2026-08-23
// nothing checked that they agree.
//
// The worse half of that: the production deploy ran `bunx @zabaca/zbc apply`
// with **no version at all**, which resolves to whatever is latest at the moment
// of the release. So the engine converging production was decided by the clock,
// against modules pinned to a tag, and because nobody typed a number nobody
// could notice it had drifted.
//
// ── why it is wired into `apply` and not left as a test ────────────────────
//
// cedarpad's only CI is `e2e.yml`, which runs Playwright. There is no unit-test
// job, no turbo test pipeline, no lefthook. A guard that lived only in a test
// file would be run by nobody — a more comfortable version of the problem
// rather than a fix. So `package.json` reads:
//
//     "apply": "bun packages/infra/check-zbc-pin.ts && zbc apply"
//
// the same shape another Zabaca tool uses to stop an apply running from a worktree. Every
// apply in this repo passes through it (production and preview),
// including `packages/canvas/scripts/deploy.sh`, which now calls `bun run apply`
// instead of an unpinned `bunx`.
//
// ── the failure directions, all of them refusals ───────────────────────────
//
// An ABSENT record fails. If a missing tag read as "nothing to compare", then
// deleting `vendor/zbc/VENDORING.md` would silently switch the guard off and
// every apply would go green — the same shape as a Cloudflare LIST endpoint
// answering `success: true, result: []` for a token that lacks the scope, which
// cost four confident wrong answers in one day. An answer that carries no
// information must never read as a pass.
//
// A RANGE fails. `^0.12.0` installs 0.12.x, which is "nobody typed a number" in
// a shorter form.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export type PinResult = { ok: true } | { ok: false; why: string }

/** The tag `vendor/zbc/VENDORING.md` records, or undefined if it records none. */
export function declaredTag(root: string): string | undefined {
  let text: string
  try {
    text = readFileSync(join(root, 'vendor', 'zbc', 'VENDORING.md'), 'utf8')
  } catch {
    return undefined
  }
  return /\bzbc-core-v\d+\.\d+\.\d+\b/.exec(text)?.[0]
}

/** The exact `@zabaca/zbc` version the root package.json pins, if it is exact. */
export function declaredVersion(root: string): string | undefined {
  let pkg: { devDependencies?: Record<string, string>; dependencies?: Record<string, string> }
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
  return pkg.devDependencies?.['@zabaca/zbc'] ?? pkg.dependencies?.['@zabaca/zbc']
}

/**
 * Whether the two agree. Pure; exported for tests.
 *
 * Both numbers are named in the failure, because the reader's next question is
 * "which of the two is wrong" and a message naming one of them cannot answer it.
 */
export function comparePin(input: {
  tag: string | undefined
  version: string | undefined
}): PinResult {
  if (input.tag === undefined) {
    return {
      ok: false,
      why:
        'vendor/zbc/VENDORING.md records no `zbc-core-v*` tag, so there is nothing to compare ' +
        'the engine against. That file is the only record of which modules are vendored here.',
    }
  }
  if (input.version === undefined) {
    return {
      ok: false,
      why: 'the root package.json pins no `@zabaca/zbc` version, so the engine is whatever ran.',
    }
  }
  if (!/^\d+\.\d+\.\d+$/.test(input.version)) {
    return {
      ok: false,
      why:
        `@zabaca/zbc is pinned as "${input.version}", which is a range rather than a version. ` +
        `The vendored modules are at ${input.tag}; pin the engine to the same number exactly.`,
    }
  }
  if (`zbc-core-v${input.version}` !== input.tag) {
    return {
      ok: false,
      why:
        `the vendored modules are at ${input.tag} and the engine is @zabaca/zbc ` +
        `${input.version}. They are one number in two files and they disagree: either pull ` +
        `vendor/zbc to zbc-core-v${input.version}, or pin the engine to ` +
        `${input.tag.replace('zbc-core-v', '')}.`,
    }
  }
  return { ok: true }
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..', '..')
  const result = comparePin({ tag: declaredTag(root), version: declaredVersion(root) })
  if (!result.ok) {
    console.error(`apply refused: ${result.why}`)
    process.exit(1)
  }
}
