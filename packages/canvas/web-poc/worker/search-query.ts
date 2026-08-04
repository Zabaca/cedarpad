/**
 * A user's words turned into an FTS5 MATCH expression, as TEXT. Every token is
 * wrapped in double quotes (with embedded quotes doubled), so `AND`, `*`, `:`,
 * `NEAR(` and friends are searched for rather than executed — a query is never
 * an injection into the match grammar. Returns `null` when nothing is left to
 * search for.
 *
 * Shared by `GET /v1/search` and the `notebook_search` MCP tool: one rule, so the
 * two surfaces cannot disagree about what a query means.
 */
export function matchExpression(q: string): string | null {
  const tokens = q
    .split(/\s+/)
    .map((t) => t.replace(/["]/g, ""))
    // Strip anything that isn't a word character; a token of pure punctuation
    // ("*", "-") has nothing to match and would only quote to an empty string.
    .filter((t) => /[\p{L}\p{N}]/u.test(t));
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" ");
}
