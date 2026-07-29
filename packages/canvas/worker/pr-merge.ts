import { parsePrUrl } from '../shared/pr-url.ts';

// The GitHub half of the Inbox merge (CONTEXT.md "Open PR"). Merging is an EDGE act: the
// GitHub App private key never leaves the edge (ADR-0008), so the container — which is the
// side running agent-authored code — cannot merge even in principle. This module holds only
// the call; who may make it, and against which repo, is decided in `inbox.ts`.
//
// Squash-only, deliberately: a dev-agent PR is one self-contained candidate carrying its own
// decision record, so one commit on main is what the triage law's "reversible in one revert"
// actually means. Offering a strategy picker would be a second decision at the moment you
// just want to land the run.

export type MergeResult =
  | { ok: true }
  | {
      ok: false;
      /** GitHub says the PR is already merged — the row was stale, not the merge refused.
       *  The caller records it as merged rather than showing an error. */
      alreadyMerged: boolean;
      /** GitHub's own words where we have them ("Pull Request is not mergeable", a failing
       *  required check), so the human can act on the reason instead of just retrying. */
      reason: string;
    };

const refuse = (reason: string, alreadyMerged = false): MergeResult => ({ ok: false, alreadyMerged, reason });

export async function mergePullRequest(opts: {
  /** The PR url recorded on the Conversation. Re-parsed here — the request target is derived
   *  from the link itself, never assembled from caller-supplied coordinates. */
  prUrl: string;
  /** A repo-scoped installation token (or an opened PAT) with `pull_requests: write`. */
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<MergeResult> {
  const coords = parsePrUrl(opts.prUrl);
  if (!coords) return refuse('Not a GitHub pull-request url.');
  const doFetch = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await doFetch(`https://api.github.com/repos/${coords.owner}/${coords.repo}/pulls/${coords.number}/merge`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'cedarpad-inbox-merge',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ merge_method: 'squash' }),
    });
  } catch (e: unknown) {
    // The network is a refusal, not an exception: the Inbox shows it beside the button and
    // the row keeps its open-PR state, so retrying is one click.
    return refuse(String(e instanceof Error ? e.message : e));
  }

  if (res.ok) return { ok: true };

  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  const message = body?.message ?? `GitHub refused the merge (${res.status}).`;
  // GitHub answers 405 both for "not mergeable" and for a PR that is already merged; only
  // the message distinguishes them, and they mean opposite things to the Inbox.
  return refuse(message, /already merged/i.test(message));
}
