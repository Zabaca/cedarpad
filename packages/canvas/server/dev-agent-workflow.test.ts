import { describe, expect, test } from 'bun:test';

import type { PrRequest, Worktree } from './repo-worktree.ts';
import {
  DEV_AGENT_KIND,
  type OpenPrDeps,
  isDevAgentConversation,
  openDevAgentPr,
} from './dev-agent-workflow.ts';

// ── PR half: the `open_pr` tool ────────────────────────────────────────────────────────

function makeFakeGit() {
  const calls: string[] = [];
  const wt: Worktree = { path: '/fake/wt', branch: 'dev-agent/improve-arch-run1', hub: '/fake/hub' };
  let opened: { wt: Worktree; req: PrRequest } | null = null;
  let committedMessage: string | null = null;
  const git = {
    commit: async (_wt: Worktree, message: string) => {
      calls.push('commit');
      committedMessage = message;
      return true;
    },
    pushAndOpenPR: async (w: Worktree, req: PrRequest) => {
      calls.push('pushAndOpenPR');
      opened = { wt: w, req };
      return 'https://github.com/Zabaca/cedarpad/pull/999';
    },
  };
  return {
    git,
    wt,
    calls,
    get opened() {
      return opened;
    },
    get committedMessage() {
      return committedMessage;
    },
  };
}

describe('openDevAgentPr — the open_pr tool drives commit → PR on the runner worktree', () => {
  test('commits the runner worktree, then pushes+opens the PR with the agent-supplied fields', async () => {
    const fake = makeFakeGit();
    const deps: OpenPrDeps = { git: fake.git, worktree: fake.wt };

    const url = await openDevAgentPr(deps, {
      title: 'Deepen the Inbox promote protocol',
      body: 'as discussed in the thread',
      commitMessage: 'refactor: deepen the Inbox promote protocol',
    });

    expect(url).toBe('https://github.com/Zabaca/cedarpad/pull/999');
    // No prepare/cleanup: the tool acts on the runner's OWN live worktree, in order.
    expect(fake.calls).toEqual(['commit', 'pushAndOpenPR']);
    expect(fake.committedMessage).toBe('refactor: deepen the Inbox promote protocol');
    expect(fake.opened!.wt).toBe(fake.wt);
    expect(fake.opened!.req).toEqual({ title: 'Deepen the Inbox promote protocol', body: 'as discussed in the thread' });
  });

  test('clean tree (nothing to commit) → no PR, returns null', async () => {
    const fake = makeFakeGit();
    fake.git.commit = async () => false; // nothing to commit
    const deps: OpenPrDeps = { git: fake.git, worktree: fake.wt };

    const url = await openDevAgentPr(deps, { title: 't', body: 'b', commitMessage: 'noop' });

    expect(url).toBeNull();
    expect(fake.calls).not.toContain('pushAndOpenPR');
  });
});

// ── routing ───────────────────────────────────────────────────────────────────────────

describe('isDevAgentConversation — the session-type predicate', () => {
  test('true for a dev-agent-KINDED Conversation, false for a chat', () => {
    expect(isDevAgentConversation({ kind: DEV_AGENT_KIND })).toBe(true);
    expect(isDevAgentConversation({ kind: 'chat' })).toBe(false);
  });
});
