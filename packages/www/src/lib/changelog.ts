// The public changelog (ADR-0025).
//
// `CHANGELOG.md` at the repo root is the single source of truth: the release skill appends a
// release to it, and this parses it at BUILD time so cedarpad.com/changelog is baked into the
// static page. Nothing reads it at runtime.
//
// This is the contract between a file the release skill writes and a page the public reads,
// and markdown drift is silent — a renamed heading would just quietly vanish from the site.
// So the parser is strict and THROWS rather than skipping: a malformed entry fails
// `bun test` and the www build, which is the whole reason it exists.

/** Sections shown on cedarpad.com. Keep-a-changelog's vocabulary, minus what we don't use. */
export const PUBLIC_HEADINGS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security'] as const
/** Recorded in CHANGELOG.md, never rendered publicly — refactors, CI, test coverage. */
export const INTERNAL_HEADING = 'Internal'

const KNOWN_HEADINGS: readonly string[] = [...PUBLIC_HEADINGS, INTERNAL_HEADING]

export type ChangelogSection = { heading: string; items: string[] }
export type Release = { version: string; date: string; sections: ChangelogSection[] }

/** `## [0.2.0] — 2026-07-31` — either dash, but the version and the date are exact. */
const RELEASE_RE = /^##\s+\[(\d+\.\d+\.\d+)\]\s+[—-]\s+(\d{4}-\d{2}-\d{2})\s*$/
const SECTION_RE = /^###\s+(.+?)\s*$/
const ITEM_RE = /^-\s+(.*\S)\s*$/

/**
 * Every release in the file, in file order, including internal-only ones.
 * @throws on anything that does not match the documented shape.
 */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  let release: Release | null = null
  let section: ChangelogSection | null = null
  let fenced = false

  for (const [i, line] of markdown.split('\n').entries()) {
    const where = `CHANGELOG.md line ${i + 1}`

    // CHANGELOG.md documents its own format, so it holds an example release inside a fence.
    // Everything between fences is documentation and is skipped wholesale.
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue

    // `## [` marks INTENT to be a release, so a prose heading in the preamble ("## How to
    // write an entry") stays prose while a version heading that is merely malformed
    // ("## [0.2.0] (July)") still throws instead of being silently skipped.
    if (line.startsWith('## [')) {
      const m = RELEASE_RE.exec(line)
      if (!m)
        throw new Error(
          `${where}: malformed release heading ${JSON.stringify(line)} — expected "## [1.2.3] — YYYY-MM-DD"`,
        )
      if (release) finish(release, where)
      const [, version, date] = m as unknown as [string, string, string]
      if (releases.some((r) => r.version === version))
        throw new Error(`${where}: version ${version} appears twice`)
      release = { version, date, sections: [] }
      releases.push(release)
      section = null
      continue
    }

    if (line.startsWith('### ')) {
      const heading = SECTION_RE.exec(line)?.[1]
      // A `###` before any `##` means the file's structure is wrong, not just a stray line.
      if (!release)
        throw new Error(`${where}: section "${heading}" appears before any release heading`)
      if (!heading || !KNOWN_HEADINGS.includes(heading)) {
        throw new Error(
          `${where}: unknown section heading "${heading}" — expected one of ${KNOWN_HEADINGS.join(', ')}`,
        )
      }
      section = { heading, items: [] }
      release.sections.push(section)
      continue
    }

    const item = ITEM_RE.exec(line)?.[1]
    if (item === undefined) continue // prose, blank lines, and the preamble before release one
    // An item under a release but under no section would silently never render.
    if (release && !section)
      throw new Error(`${where}: item ${JSON.stringify(item)} sits outside any section`)
    section?.items.push(item)
  }
  if (release) finish(release, 'CHANGELOG.md')

  return releases
}

function finish(release: Release, where: string): void {
  if (release.sections.length === 0)
    throw new Error(`${where}: release ${release.version} has no sections`)
  const empty = release.sections.find((s) => s.items.length === 0)
  if (empty)
    throw new Error(`${where}: release ${release.version} has an empty "${empty.heading}" section`)
}

/** PR references are traceability for us; the repo is private, so they never reach the page. */
const PR_REF_RE = /\s*\(#\d+\)/g
const BOLD_RE = /\*\*(.+?)\*\*/g
const CODE_RE = /`([^`]+)`/g
const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * One changelog item as HTML. The entries use a deliberately tiny slice of markdown — bold,
 * code, links — so this renders that slice rather than pulling in a markdown pipeline for a
 * handful of lines. Escaping happens FIRST, so the patterns below only ever match text we
 * have already made inert.
 * @throws on a link target that is neither http(s) nor site-relative.
 */
export function renderItem(item: string): string {
  return escapeHtml(item.replace(PR_REF_RE, ''))
    .replace(CODE_RE, (_, code) => `<code>${code}</code>`)
    .replace(BOLD_RE, (_, text) => `<strong>${text}</strong>`)
    .replace(LINK_RE, (_, text, href: string) => {
      if (!/^(https?:\/\/|\/)/.test(href))
        throw new Error(`CHANGELOG.md: unsupported link target ${JSON.stringify(href)}`)
      return `<a href="${href}">${text}</a>`
    })
}

/**
 * What cedarpad.com renders: the same releases with `### Internal` removed, and releases
 * that carried nothing else dropped entirely — a version whose only content was CI work has
 * nothing to say to someone using the product.
 */
export function publicReleases(markdown: string): Release[] {
  return parseChangelog(markdown)
    .map((r) => ({ ...r, sections: r.sections.filter((s) => s.heading !== INTERNAL_HEADING) }))
    .filter((r) => r.sections.length > 0)
}
