/**
 * The PR url a dev-agent run reports (`open_pr`) → the GitHub coordinates a merge addresses.
 * Pure, and shared by both ends of the contract (CLAUDE.md §7): the platform RPC refuses a
 * url this cannot read, and the edge merge route builds
 * `/repos/:owner/:repo/pulls/:number/merge` from what it returns.
 *
 * Deliberately strict — `https://github.com/...` only. The url is written by an agent and
 * then handed to an authenticated request, so "looks like a PR link" is not good enough:
 * anything this accepts is somewhere the edge will send a repo-scoped token.
 */
export interface PrCoords {
  owner: string;
  repo: string;
  number: number;
}

// owner/repo are GitHub's own name charset; the trailing group swallows the `/files`-style
// tab suffix you get from copying the browser's url.
const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/[\w.-]*)?$/;

export function parsePrUrl(url: string): PrCoords | null {
  const m = PR_URL.exec(url.trim());
  if (!m) return null;
  return { owner: m[1] as string, repo: m[2] as string, number: Number(m[3]) };
}
