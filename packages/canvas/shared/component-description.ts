// A Component's DESCRIPTION, derived from its source. Shared because three places now need
// the same answer and a second implementation would drift: the container (a file on disk),
// the EDGE (a Record's source, which never touches a filesystem), and the build-time platform
// manifest generator. It lives here rather than in `server/components.ts` only so the edge can
// import it without `node:fs` coming along.

// Pure: the leading line-comment (or block-comment) of a module's source, as one
// line — agents open components with a describing comment, which the gallery shows
// as the card description. Empty string when there is none.
export function leadingComment(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (out.length === 0 && l === '') continue;
    if (l.startsWith('//')) out.push(l.replace(/^\/\/\s?/, ''));
    else if (out.length === 0 && l.startsWith('/*')) out.push(l.replace(/^\/\*+\s?/, '').replace(/\*+\/\s*$/, ''));
    else if (out.length > 0 && (l.startsWith('*') || l.endsWith('*/'))) out.push(l.replace(/^\*+\s?/, '').replace(/\*+\/\s*$/, ''));
    else break;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}
