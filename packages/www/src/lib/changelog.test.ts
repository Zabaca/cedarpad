import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseChangelog, publicReleases, renderItem } from './changelog'

const SAMPLE = `# Changelog

Preamble prose that is not a release.

## [0.2.0] — 2026-07-31

### Added
- **Ilograph diagrams** — perspectives and drill-down. (#393)

### Internal
- Cold-container e2e coverage.

## [0.1.0] — 2026-07-15

### Fixed
- Components no longer vanish after a restart.
`

describe('parseChangelog', () => {
  test('reads each release with its version, date, and sections in file order', () => {
    const releases = parseChangelog(SAMPLE)

    expect(releases.map((r) => r.version)).toEqual(['0.2.0', '0.1.0'])
    expect(releases[0]?.date).toBe('2026-07-31')
    expect(releases[0]?.sections.map((s) => s.heading)).toEqual(['Added', 'Internal'])
    expect(releases[0]?.sections[0]?.items).toEqual([
      '**Ilograph diagrams** — perspectives and drill-down. (#393)',
    ])
  })

  test('preamble before the first release is not mistaken for content', () => {
    expect(parseChangelog(SAMPLE)[0]?.version).toBe('0.2.0')
    expect(parseChangelog('# Changelog\n\nNothing released yet.\n')).toEqual([])
  })

  // The whole point of the guard: the release skill writes this file, www parses it, and a
  // drift between the two would silently drop content from the public page. Loudly instead.
  test('rejects a section heading outside the known set', () => {
    expect(() => parseChangelog('## [0.1.0] — 2026-07-15\n\n### Improvements\n- nope\n')).toThrow(
      /Improvements/,
    )
  })

  test('rejects a release heading that is not a version and an ISO date', () => {
    expect(() => parseChangelog('## [0.1.0] (July)\n\n### Added\n- x\n')).toThrow(
      /release heading/i,
    )
    expect(() => parseChangelog('## [0.1] — 2026-07-15\n\n### Added\n- x\n')).toThrow(
      /release heading/i,
    )
  })

  // The file's own preamble carries prose headings. `## [` is what marks a line as intending
  // to be a release — so prose is left alone without weakening the check above.
  test('a prose ## heading in the preamble is not a release', () => {
    expect(parseChangelog('# Changelog\n\n## How to write an entry\n\nProse.\n')).toEqual([])
  })

  test('rejects a release with no sections, and items outside any section', () => {
    expect(() => parseChangelog('## [0.1.0] — 2026-07-15\n\nnothing\n')).toThrow(/no sections/i)
    expect(() => parseChangelog('## [0.1.0] — 2026-07-15\n- orphan\n\n### Added\n- x\n')).toThrow(
      /outside/i,
    )
  })

  test('rejects the same version appearing twice', () => {
    const dup = '## [0.1.0] — 2026-07-15\n### Added\n- a\n## [0.1.0] — 2026-07-16\n### Added\n- b\n'
    expect(() => parseChangelog(dup)).toThrow(/0\.1\.0/)
  })
})

describe('publicReleases', () => {
  test('drops the Internal section but keeps the rest of the release', () => {
    const [latest] = publicReleases(SAMPLE)

    expect(latest?.version).toBe('0.2.0')
    expect(latest?.sections.map((s) => s.heading)).toEqual(['Added'])
  })

  test('omits a release entirely when internal work is all it contains', () => {
    const internalOnly = '## [0.3.0] — 2026-08-01\n\n### Internal\n- ci only\n'

    expect(parseChangelog(internalOnly)).toHaveLength(1)
    expect(publicReleases(internalOnly)).toEqual([])
  })
})

describe('renderItem', () => {
  test('renders the inline markdown the entries actually use', () => {
    expect(renderItem('**Bold** and `code`')).toBe('<strong>Bold</strong> and <code>code</code>')
    expect(renderItem('see [the docs](https://cedarpad.com/why)')).toBe(
      'see <a href="https://cedarpad.com/why">the docs</a>',
    )
  })

  // The repo is PRIVATE. A linked (#393) would 404 for every visitor, and even as plain text
  // a PR number is traceability for us, not information for someone using the product. It
  // stays in CHANGELOG.md and is dropped here.
  test('strips PR references rather than linking into a private repo', () => {
    expect(renderItem('Ilograph diagrams. (#393)')).toBe('Ilograph diagrams.')
    expect(renderItem('Two of them. (#389) (#390)')).toBe('Two of them.')
  })

  test('escapes HTML in the source text', () => {
    expect(renderItem('a <script>alert(1)</script> tag & an ampersand')).toBe(
      'a &lt;script&gt;alert(1)&lt;/script&gt; tag &amp; an ampersand',
    )
  })

  test('refuses a link target that is not http(s) or site-relative', () => {
    expect(() => renderItem('[click](javascript:alert(1))')).toThrow(/link target/i)
  })
})

// CHANGELOG.md documents its own format, so it contains an EXAMPLE release heading. Inside a
// fenced block that must stay an example — otherwise the file's own documentation parses as
// a release and shows up on the site.
test('a fenced code block is documentation, not content', () => {
  const withExample = [
    '# Changelog',
    '',
    'Write entries like this:',
    '',
    '```markdown',
    '## [1.2.3] — 2026-01-01',
    '### Added',
    '- An example that must not be parsed.',
    '```',
    '',
    '## [0.1.0] — 2026-07-31',
    '',
    '### Added',
    '- A real one.',
  ].join('\n')

  expect(parseChangelog(withExample).map((r) => r.version)).toEqual(['0.1.0'])
})

// The guard ADR-0025 promises: the file the release skill actually writes must parse. This is
// what turns "the format is a contract" into something enforced rather than described.
test('the committed CHANGELOG.md parses', () => {
  const md = readFileSync(new URL('../../../../CHANGELOG.md', import.meta.url), 'utf8')

  expect(() => parseChangelog(md)).not.toThrow()
  for (const release of publicReleases(md)) {
    expect(release.sections.every((s) => s.items.length > 0)).toBe(true)
    for (const item of release.sections.flatMap((s) => s.items))
      expect(() => renderItem(item)).not.toThrow()
  }
})
