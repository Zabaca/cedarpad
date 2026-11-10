// Turning a human's page REFERENCE into the page id the write path takes.
//
// This lives outside the wire contract on purpose. `shared/canvas-mutation.ts` speaks page
// IDS and nothing else — the room validates records, and a record's `parentId` is an id —
// so teaching the Durable Object about names would put a naming policy in the one place
// that should only ever assert structure. Resolution belongs to the tool layer, where the
// caller is a model that was handed a name by a human, and where a refusal can be phrased
// as a sentence that lists the alternatives.
//
// Both tool surfaces import this: `worker/mcp-tools.ts` (outside agents, over MCP) and
// `src/canvas-ops.ts` (the in-canvas agent). One resolver means "page 3" means the same
// thing on both, including which way it fails.

import type { CanvasPage } from '../src/shapes.ts';

/** A page reference was not resolvable to exactly one page. Carries a message naming what
 *  IS available: the caller is an LLM acting on a human's words, and "no page called X"
 *  without the list is an answer it cannot recover from without another tool call. */
export class PageRefError extends Error {}

const quoted = (pages: CanvasPage[]): string => (pages.length ? pages.map((p) => `"${p.name}"`).join(', ') : '(none)');

/**
 * Resolve a page reference to a page id.
 *
 * A reference is either a page id (`page:...`, as it appears on a shape's `page` field and
 * in `list_pages` output) or a page NAME as the human sees it in the page switcher. Taking
 * both in one argument is deliberate: an agent that just read a shape holds an id, and an
 * agent relaying a human request holds a name, and forcing them into different parameters
 * only invents a way to get it wrong.
 *
 * Names are tldraw's, so they are NOT unique — two pages may both be "Untitled". An
 * ambiguous name is REFUSED rather than resolved to the first match, for the same reason
 * `applyMutation` refuses an unknown page instead of redirecting to the default: picking
 * one silently is indistinguishable from data loss when the human looks at the other.
 *
 * Matching is exact first, then case-insensitive. The fallback is what makes a page called
 * "Roadmap" reachable when the human said "roadmap"; running it only after an exact match
 * fails means a canvas that really does have both "Roadmap" and "roadmap" resolves each to
 * itself rather than calling them ambiguous.
 */
export function resolvePageRef(pages: CanvasPage[], ref: string): string {
  const wanted = ref.trim();
  if (!wanted) throw new PageRefError(`no page named "${ref}" — this canvas has ${quoted(pages)}`);

  if (wanted.startsWith('page:')) {
    if (pages.some((p) => p.id === wanted)) return wanted;
    throw new PageRefError(`no page with id ${wanted} on this canvas — its pages are ${quoted(pages)}`);
  }

  const exact = pages.filter((p) => p.name === wanted);
  const matches = exact.length ? exact : pages.filter((p) => p.name.toLowerCase() === wanted.toLowerCase());

  if (matches.length === 1) return matches[0]!.id;
  if (matches.length === 0) throw new PageRefError(`no page named "${wanted}" — this canvas has ${quoted(pages)}`);
  throw new PageRefError(
    `"${wanted}" matches ${matches.length} pages on this canvas (${matches.map((p) => p.id).join(', ')}) — name one by its id instead`,
  );
}
