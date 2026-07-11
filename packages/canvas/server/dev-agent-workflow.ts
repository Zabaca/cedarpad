// The dev-agent's conversation-side pieces (ADR-0009 Tier 2 → ADR-0010 → ADR-0011).
//
// A dev-agent RUN is a headless bridge chat turn now (ADR-0011, see bridge.ts's
// /api/dev-agent/run): the agent itself explores, applies the declined-marker dedup, and
// calls `ask_human` — the old code harness (Explore → parse → gate → promote) dissolved
// into the run prompt. What remains here is what the CONVERSATION needs:
//
//   DEV_AGENT_WORKSPACE_ID / isDevAgentConversation — the logical tag + routing predicate.
//   openDevAgentPr — the `open_pr` tool body: commit the conversation's prepared worktree
//                    and open the PR (the durable code artifact, ADR-0007/0010).

import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { PrRequest, Worktree } from './repo-worktree.ts';

// ── Which Conversations are dev-agent workflows ───────────────────────────────────────
//
// Dev-agent-ness is the Conversation's KIND — a session TYPE, not a workspace. The rows
// live in the workspace they run in (the default container's), like any chat; `kind`
// carries what used to be the `workspace_id = 'dev-agent'` logical tag (the fake workspace
// overloaded routing/mint/labeling onto a field that means "isolated environment"). The
// edge proxy mints the per-send git token for this kind; the bridge's `turnFlavor` files
// token-armed turns under it. The same string also prefixes dev-agent PR branch names.
export const DEV_AGENT_KIND = 'dev-agent';

/** True iff this Conversation is a dev-agent session (so its sends are token-armed and it
 *  opens its PR via the `open_pr` tool). */
export function isDevAgentConversation(conv: Pick<ConversationRow, 'kind'>): boolean {
  return conv.kind === DEV_AGENT_KIND;
}

// ── The PR half: the `open_pr` tool ───────────────────────────────────────────────────

/** The git seam — structurally satisfied by the #64 manager (`createRepoWorktreeManager`);
 *  tests inject a fake. The in-conversation `open_pr` tool only ever `commit`s +
 *  `pushAndOpenPR`s the conversation's prepared worktree. */
export interface RepoWorktreeManager {
  prepareWorktree: (branch: string) => Promise<Worktree>;
  commit: (wt: Worktree, message: string) => Promise<boolean>;
  pushAndOpenPR: (wt: Worktree, req: PrRequest) => Promise<string>;
  cleanup: (wt: Worktree) => Promise<void>;
}

export interface OpenPrDeps {
  /** The git manager, bound to the runner's workspace (#64 `createRepoWorktreeManager`). The
   *  tool needs only commit + push/PR — it operates on the conversation's PREPARED worktree
   *  (the tree the dev-agent turn ran in and edited, ADR-0010 slice 6). */
  git: Pick<RepoWorktreeManager, 'commit' | 'pushAndOpenPR'>;
  /** The conversation's prepared worktree — where the dev-agent edited during the chat. */
  worktree: Worktree;
}

/**
 * The `open_pr` tool body (ADR-0009 Tier 2, #126): commit the conversation's worktree with
 * the agent-supplied message and open the PR (#64). Returns the PR url, or null if the tree
 * was clean (nothing to open a PR for). The agent — grilling James in-thread — supplies the
 * PR title/body + commit message from the conversation it is in, so nothing is reconstructed.
 */
export async function openDevAgentPr(
  deps: OpenPrDeps,
  input: { title: string; body: string; commitMessage: string },
): Promise<string | null> {
  const committed = await deps.git.commit(deps.worktree, input.commitMessage);
  if (!committed) {
    console.log('[dev-agent] open_pr: worktree clean — no PR opened');
    return null;
  }
  const url = await deps.git.pushAndOpenPR(deps.worktree, { title: input.title, body: input.body });
  console.log(`[dev-agent] open_pr: opened PR ${url}`);
  return url;
}
