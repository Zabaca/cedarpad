import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A fork's pull request runs a workflow as the FORK wrote it, so nothing in this
// repository can stop it changing the file. What stops it doing harm is what no
// version of the file can reach: a secret, a self-hosted runner, a write token.
// GitHub withholds secrets and the write token from a fork's `pull_request` run by
// default, and the repository's "approval for all outside collaborators" setting
// holds every run until a maintainer approves it; this test keeps OUR workflows from asking for any of what
// GitHub would then have to refuse, and from using the triggers that run with the
// base repository's privileges instead (`pull_request_target`, `workflow_run`).
//
// It reads the files rather than a list of them, so a new workflow is held to the
// same rules the day it is added.

type Workflow = {
  on?: unknown
  permissions?: Record<string, string> | string
  jobs?: Record<
    string,
    {
      'runs-on'?: unknown
      permissions?: Record<string, string> | string
      steps?: Array<{ uses?: unknown; with?: Record<string, unknown> }>
    }
  >
}

/** GitHub's own runners. A label that is not one of these (`self-hosted`, a custom
 *  runner group, a scale set) is a machine somebody has to keep clean. */
const HOSTED = /^(ubuntu|windows|macos)-(latest|\d{2,4}(\.\d{2})?(-arm)?)$/

const triggers = (on: unknown): string[] =>
  typeof on === 'string' ? [on] : Array.isArray(on) ? (on as string[]) : on && typeof on === 'object' ? Object.keys(on) : []

const writes = (p: Record<string, string> | string | undefined) =>
  typeof p === 'string' ? p === 'write-all' : Object.values(p ?? {}).some((v) => v === 'write')

/** Every key and value of the parsed workflow, at any depth. */
function walk(value: unknown, visit: (key: string | undefined, value: unknown) => void, key?: string): void {
  visit(key, value)
  if (Array.isArray(value)) for (const item of value) walk(item, visit, key)
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, visit, k)
}

/** Does the workflow read the `secrets` context in any form? It looks at the PARSED values, not the
 *  text, so how the YAML is written (block scalars, flow mappings, quoted keys) cannot hide a read.
 *  The word is matched case-insensitively (`SECRETS.X` is the same context) and is looked for:
 *    - inside any `${{ ... }}` in any value, closed or not, on one line or several, so `secrets['X']`,
 *      `toJSON(secrets)` and `format('{0}', secrets.X)` count as well as `secrets.X`;
 *    - in the whole value of an `if:`, which is an expression without the braces;
 *    - as a `secrets` key anywhere, which passes secrets (`inherit` or a mapping) to a reusable workflow.
 *  A word that only contains it (`mysecrets`, `secrets_url`) is not the context, and neither is prose in a
 *  `run:` script or a comment. */
function usesSecret(wf: unknown): boolean {
  let found = false
  walk(wf, (key, value) => {
    if (key !== undefined && key.toLowerCase() === 'secrets') found = true
    if (typeof value !== 'string') return
    if (key === 'if' && /\bsecrets\b/i.test(value)) found = true
    if (/\$\{\{(?:(?!\}\})[\s\S])*?\bsecrets\b/i.test(value)) found = true
  })
  return found
}

/** The only triggers a fork's contribution can start without the base repository's privileges and that
 *  our workflows need. Anything else is a run nobody planned for. */
const ALLOWED_TRIGGERS = ['push', 'pull_request', 'workflow_dispatch']

/** The triggers that run with the base repository's privileges (secrets, a write token) on a fork's behalf.
 *  Named in the message, though they are also outside ALLOWED_TRIGGERS. */
const REFUSED_TRIGGERS = ['pull_request_target', 'workflow_run']

/** Every `actions/checkout` step that does not turn off persist-credentials. */
function checkoutsKeepingCredentials(wf: Workflow): number {
  let n = 0
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (typeof step.uses === 'string' && /^actions\/checkout(@|$)/i.test(step.uses)) {
        const v = step.with?.['persist-credentials']
        if (v !== false && v !== 'false') n += 1
      }
    }
  }
  return n
}

/** Every way this workflow could hand a fork's pull request something it must not have. */
function violations(text: string): string[] {
  const wf = Bun.YAML.parse(text) as Workflow
  const found: string[] = []

  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    const label = job['runs-on']
    if (typeof label !== 'string' || !HOSTED.test(label)) {
      found.push(`job ${name} runs on ${JSON.stringify(label)}, not a GitHub-hosted runner`)
    }
    if ('permissions' in job && job.permissions == null) found.push(`job ${name} has a bare permissions: key (null)`)
    else if (writes(job.permissions)) found.push(`job ${name} asks for a write token`)
  }

  if (usesSecret(wf)) found.push('it uses a secret')

  // YAML 1.1 reads a bare `on` as the boolean true, and Bun's parser (1.3.4, the version CI pins)
  // keeps that key as "true" where newer ones keep "on". Read either, or the check sees no triggers.
  const on = triggers(wf.on ?? (wf as Record<string, unknown>).true)
  if (on.length === 0) found.push('it has no trigger')
  for (const t of REFUSED_TRIGGERS) {
    if (on.includes(t)) found.push(`it triggers on ${t}, which runs with the base repository's privileges`)
  }
  for (const t of on) {
    if (!ALLOWED_TRIGGERS.includes(t) && !REFUSED_TRIGGERS.includes(t)) found.push(`it triggers on ${t}, which is not one of ${ALLOWED_TRIGGERS.join(', ')}`)
  }

  if (wf.permissions == null) found.push('it sets no top-level permissions (or a bare permissions: key), so the token gets the repository default')
  else if (writes(wf.permissions)) found.push('its top-level permissions include a write')

  const kept = checkoutsKeepingCredentials(wf)
  if (kept > 0) found.push(`${kept} actions/checkout step(s) leave the job token in .git/config (set persist-credentials: false)`)

  return found
}

describe('a fork cannot reach a secret or a self-hosted runner through our workflows', () => {
  const dir = join(import.meta.dir, '..', '..', '.github', 'workflows')
  const files = readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))

  test('there are workflows to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    test(`${file}`, () => {
      expect(violations(readFileSync(join(dir, file), 'utf8'))).toEqual([])
    })
  }
})

describe('the guard catches what it exists to catch', () => {
  const ok = `
on:
  pull_request:
permissions:
  contents: read
jobs:
  a:
    runs-on: ubuntu-latest
    steps: []
`

  test('a clean workflow has no violations', () => {
    expect(violations(ok)).toEqual([])
  })

  test('a self-hosted runner, however it is spelled', () => {
    expect(violations(ok.replace('ubuntu-latest', 'self-hosted'))).toHaveLength(1)
    expect(violations(ok.replace('ubuntu-latest', '[self-hosted, linux, x64]'))).toHaveLength(1)
    expect(violations(ok.replace('ubuntu-latest', 'ci-shared-pool'))).toHaveLength(1)
  })

  test('GitHub-hosted labels are accepted', () => {
    for (const l of ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-14', 'windows-2022']) {
      expect(violations(ok.replace('ubuntu-latest', l))).toEqual([])
    }
  })

  test('a secret, as an expression or inherited', () => {
    expect(violations(ok.replace('steps: []', 'steps:\n      - run: echo\n        env:\n          T: ${{ secrets.TOKEN }}'))).toHaveLength(1)
    expect(violations(ok.replace('steps: []', 'secrets: inherit'))).toHaveLength(1)
  })

  // The check reads the PARSED values, so how the YAML is written does not matter: a block scalar, a flow
  // mapping, a quoted key, any letter case.
  test.each([
    ['a folded block scalar if', 'steps:\n      - if: >-\n          secrets.X\n          != \'\'\n        run: echo hi'],
    ['a literal block scalar if', 'steps:\n      - if: |\n          secrets.X != \'\'\n        run: echo hi'],
    ['a flow mapping step', 'steps:\n      - { if: "secrets.X != \'\'", run: echo hi }'],
    ['a quoted if key', 'steps:\n      - "if": secrets.X\n        run: echo hi'],
    ['a single-quoted if key and value', "steps:\n      - 'if': 'secrets.X'\n        run: echo hi"],
    ['an upper-case expression', 'steps:\n      - run: echo\n        env:\n          T: ${{ SECRETS.X }}'],
    ['a mixed-case expression', 'steps:\n      - run: echo\n        env:\n          T: ${{ Secrets[\'X\'] }}'],
    ['an upper-case if', 'steps:\n      - if: SECRETS.X\n        run: echo hi'],
    ['an upper-case secrets key', 'uses: ./.github/workflows/other.yml\n    SECRETS: inherit'],
    ['a quoted secrets key', 'uses: ./.github/workflows/other.yml\n    "secrets":\n      T: abc'],
    ['a flow mapping of env', 'steps:\n      - run: echo\n        env: { T: "${{ secrets.X }}" }'],
    ['a block scalar run', 'steps:\n      - run: |\n          echo "${{ secrets.X }}"'],
    ['an expression in a with input', 'steps:\n      - uses: actions/setup-node@v4\n        with:\n          token: ${{ secrets.X }}'],
  ])('a secret read in %s', (_name, body) => {
    expect(violations(ok.replace('steps: []', body)), body).toHaveLength(1)
  })

  test('the word in prose, in a comment or in a run script is not a read', () => {
    expect(violations(`# secrets.X and \${{ secrets.X }} in a comment\n${ok.replace('steps: []', 'steps:\n      - run: echo "no secrets here"')}`)).toEqual([])
  })

  // The context `secrets` can be read without writing `secrets.NAME`: by index, as a whole object,
  // through a function, across lines, or in a bare `if:`. The guard looks for the word inside any
  // expression, not for one spelling of it.
  test.each([
    ["secrets['NPM_TOKEN']", "${{ secrets['NPM_TOKEN'] }}"],
    ['toJSON(secrets)', '${{ toJSON(secrets) }}'],
    ['fromJSON(toJSON(secrets)).X', '${{ fromJSON(toJSON(secrets)).X }}'],
    ["format('{0}', secrets.X)", "${{ format('{0}', secrets.X) }}"],
    ['no spaces', '${{secrets.X}}'],
    ['inside a condition', "${{ github.ref == 'refs/heads/main' && secrets.X }}"],
    ['an unterminated expression', '${{ secrets.X'],
  ])('a secret read as %s', (_name, expression) => {
    const text = ok.replace('steps: []', `steps:\n      - run: echo hi\n        env:\n          T: ${expression}`)
    expect(violations(text), expression).toHaveLength(1)
  })

  test('a secret read in an expression that runs over several lines', () => {
    const text = ok.replace('steps: []', 'steps:\n      - run: |\n          echo ${{\n            secrets.X\n          }}')
    expect(violations(text)).toHaveLength(1)
  })

  test('a secret in a bare if: condition, and a secrets: mapping passed to a reusable workflow', () => {
    expect(violations(ok.replace('steps: []', 'steps:\n      - if: secrets.X != \'\'\n        run: echo hi'))).toHaveLength(1)
    expect(violations(ok.replace('steps: []', 'uses: ./.github/workflows/other.yml\n    secrets:\n      T: abc'))).toHaveLength(1)
  })

  test('expressions that merely sit near the word are not flagged', () => {
    for (const expression of ['${{ github.ref }}', "${{ matrix.mysecrets }}", '${{ github.event.repository.secrets_url }}', "${{ runner.os == 'Linux' }}"]) {
      const text = ok.replace('steps: []', `steps:\n      - run: echo hi\n        env:\n          T: ${expression}`)
      expect(violations(text), expression).toEqual([])
    }
  })

  test('the triggers that run with the base repository privileges', () => {
    expect(violations(ok.replace('pull_request:', 'pull_request_target:'))).toHaveLength(1)
    expect(violations(ok.replace('pull_request:', 'workflow_run:'))).toHaveLength(1)
  })

  // Only the triggers a fork can start without privileges, and ours need: push, pull_request,
  // workflow_dispatch. Anything else is a way to start a run nobody planned for.
  test('only push, pull_request and workflow_dispatch', () => {
    for (const trigger of ['pull_request', 'push', 'workflow_dispatch']) {
      expect(violations(ok.replace('pull_request:', `${trigger}:`)), trigger).toEqual([])
    }
    expect(violations(ok.replace('pull_request:', 'push:\n  pull_request:\n  workflow_dispatch:'))).toEqual([])
    for (const trigger of ['schedule', 'issue_comment', 'issues', 'pull_request_review', 'pull_request_review_comment', 'repository_dispatch', 'workflow_call', 'release', 'fork', 'watch', 'discussion']) {
      expect(violations(ok.replace('pull_request:', `${trigger}:`)), trigger).toHaveLength(1)
    }
    expect(violations(ok.replace('pull_request:', 'push:\n  issue_comment:'))).toHaveLength(1)
    expect(violations(ok.replace('on:\n  pull_request:', 'on: [push, schedule]'))).toHaveLength(1)
    expect(violations(ok.replace('on:\n  pull_request:', 'on: issue_comment'))).toHaveLength(1)
  })

  // actions/checkout leaves the job's token in .git/config unless told not to; a later step in the job
  // (or a build script) could then use it.
  test('every actions/checkout step sets persist-credentials: false', () => {
    const checkout = (extra: string) => ok.replace('steps: []', `steps:\n      - uses: actions/checkout@v4${extra}`)
    expect(violations(checkout('\n        with:\n          persist-credentials: false'))).toEqual([])
    expect(violations(checkout(''))).toHaveLength(1)
    expect(violations(checkout('\n        with:\n          persist-credentials: true'))).toHaveLength(1)
    expect(violations(checkout('\n        with:\n          fetch-depth: 0'))).toHaveLength(1)
    expect(violations(ok.replace('steps: []', 'steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n      - uses: actions/checkout@v4'))).toHaveLength(1)
    // the action's name is not case-sensitive to GitHub
    expect(violations(ok.replace('steps: []', 'steps:\n      - uses: Actions/Checkout@v4'))).toHaveLength(1)
    expect(violations(ok.replace('steps: []', 'steps:\n      - uses: ACTIONS/CHECKOUT@v4\n        with:\n          persist-credentials: false'))).toEqual([])
    // other actions are not this rule's business
    expect(violations(ok.replace('steps: []', 'steps:\n      - uses: actions/setup-node@v4'))).toEqual([])
  })

  test('a write token, at workflow level or on one job, or no permissions at all', () => {
    expect(violations(ok.replace('contents: read', 'contents: write'))).toHaveLength(1)
    expect(violations(ok.replace('steps: []', 'permissions:\n      issues: write\n    steps: []'))).toHaveLength(1)
    expect(violations(ok.replace('permissions:\n  contents: read\n', ''))).toHaveLength(1)
  })

  // A bare `permissions:` parses to null. It grants nothing the file names, so the token's scope is left to the
  // repository default, which is exactly what the guard exists to refuse.
  test('a bare permissions: key (null), at workflow level or on a job', () => {
    expect(violations(ok.replace('permissions:\n  contents: read\n', 'permissions:\n'))).toHaveLength(1)
    expect(violations(ok.replace('steps: []', 'permissions:\n    steps: []'))).toHaveLength(1)
    // an explicit empty map is a stated "no permissions", which is fine
    expect(violations(ok.replace('permissions:\n  contents: read\n', 'permissions: {}\n'))).toEqual([])
    expect(violations(ok.replace('steps: []', 'permissions: {}\n    steps: []'))).toEqual([])
  })
})
