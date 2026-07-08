import { describe, expect, test } from 'bun:test';

import type { Candidate } from './dev-agent-gate.ts';
import type { PrRequest, Worktree } from './repo-worktree.ts';
import {
  DEV_AGENT_WORKSPACE_ID,
  type ApprovalDeps,
  type WorkflowDeps,
  isDevAgentConversation,
  parseCandidates,
  runDevAgentApproval,
  runDevAgentWorkflow,
  summarizeCandidates,
} from './dev-agent-workflow.ts';

// ── fakes ─────────────────────────────────────────────────────────────────────────────

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'Consolidate the transcript restore module',
  rationale: 'restore + read are two adapters of one seam split across files',
  severity: 'high',
  ...over,
});

/** A workflow deps with an in-memory askHuman spy; explore + gate injected. */
function makeWorkflow(candidates: Candidate[], opts: { declined?: string[] } = {}) {
  const promotions: Array<{ summary: string; question: string }> = [];
  const deps: WorkflowDeps = {
    repoRoot: '/fake/repo',
    explore: async () => candidates,
    readDeclined: () => opts.declined ?? [],
    // real filter (compose with #65) unless a test overrides
    askHuman: async (input) => {
      promotions.push(input);
      return 'posted';
    },
  };
  return { deps, promotions };
}

// ── scheduled half: Explore → gate → promote ──────────────────────────────────────────

describe('runDevAgentWorkflow — Explore → gate → ask_human', () => {
  test('survivors → exactly one ask_human promotion, candidates in the summary', async () => {
    const survivor = cand({ title: 'Deepen the Inbox promote protocol' });
    const { deps, promotions } = makeWorkflow([survivor]);

    const promoted = await runDevAgentWorkflow(deps);

    expect(promotions).toHaveLength(1);
    expect(promoted).toHaveLength(1);
    // the candidate title + rationale ride in the promotion the human sees
    expect(promotions[0]!.question).toContain('Deepen the Inbox promote protocol');
    expect(promotions[0]!.question).toContain(survivor.rationale);
    expect(promotions[0]!.summary).toContain('1');
  });

  test('zero survivors → zero promotions (quiet run)', async () => {
    // below the bar → gated out → nothing survives
    const { deps, promotions } = makeWorkflow([cand({ severity: 'low' })]);

    const promoted = await runDevAgentWorkflow(deps);

    expect(promotions).toHaveLength(0);
    expect(promoted).toHaveLength(0);
  });

  test('an empty explore result promotes nothing', async () => {
    const { deps, promotions } = makeWorkflow([]);
    await runDevAgentWorkflow(deps);
    expect(promotions).toHaveLength(0);
  });

  test('declined candidates are filtered before promotion (composes with #65)', async () => {
    const keep = cand({ title: 'Keep me', slug: 'keep-me' });
    const declined = cand({ title: 'Already declined', slug: 'already-declined' });
    const { deps, promotions } = makeWorkflow([keep, declined], { declined: ['already-declined'] });

    const promoted = await runDevAgentWorkflow(deps);

    // exactly one promotion, and it carries ONLY the surviving (non-declined) candidate
    expect(promotions).toHaveLength(1);
    expect(promoted.map((c) => c.title)).toEqual(['Keep me']);
    expect(promotions[0]!.question).toContain('Keep me');
    expect(promotions[0]!.question).not.toContain('Already declined');
  });

  test('all candidates declined → quiet run', async () => {
    const declined = cand({ title: 'Already declined', slug: 'already-declined' });
    const { deps, promotions } = makeWorkflow([declined], { declined: ['already-declined'] });
    await runDevAgentWorkflow(deps);
    expect(promotions).toHaveLength(0);
  });
});

describe('summarizeCandidates', () => {
  test('numbers every candidate with severity + rationale', () => {
    const { summary, question } = summarizeCandidates([
      cand({ title: 'A', rationale: 'ra', severity: 'high' }),
      cand({ title: 'B', rationale: 'rb', severity: 'medium' }),
    ]);
    expect(summary).toContain('2');
    expect(question).toContain('1. [high] A');
    expect(question).toContain('ra');
    expect(question).toContain('2. [medium] B');
    expect(question).toContain('rb');
  });
});

describe('parseCandidates — explore boundary contract', () => {
  test('extracts + validates the last json fenced block', () => {
    const text = [
      'Here are the deepening opportunities:',
      '```json',
      JSON.stringify([{ title: 'A', rationale: 'ra', severity: 'high' }]),
      '```',
    ].join('\n');
    expect(parseCandidates(text)).toEqual([{ title: 'A', rationale: 'ra', severity: 'high' }]);
  });

  test('no block / malformed / schema miss → [] (quiet)', () => {
    expect(parseCandidates('just prose, no candidates')).toEqual([]);
    expect(parseCandidates('```json\nnot json\n```')).toEqual([]);
    expect(parseCandidates('```json\n[{"title":"A"}]\n```')).toEqual([]); // missing required fields
  });
});

// ── resume half: approval → PR ────────────────────────────────────────────────────────

function makeFakeGit() {
  const calls: string[] = [];
  const wt: Worktree = { path: '/fake/wt', branch: 'dev-agent/improve-arch-run1', hub: '/fake/hub' };
  let opened: { req: PrRequest } | null = null;
  const git = {
    prepareWorktree: async (branch: string) => {
      calls.push('prepareWorktree');
      return { ...wt, branch };
    },
    commit: async (_wt: Worktree, _message: string) => {
      calls.push('commit');
      return true;
    },
    pushAndOpenPR: async (_wt: Worktree, req: PrRequest) => {
      calls.push('pushAndOpenPR');
      opened = { req };
      return 'https://github.com/Zabaca/cedarpad/pull/999';
    },
    cleanup: async (_wt: Worktree) => {
      calls.push('cleanup');
    },
  };
  return { git, calls, get opened() { return opened; } };
}

describe('runDevAgentApproval — approval drives a PR open', () => {
  test('drives prepare → commit → pushAndOpenPR exactly once, then cleanup', async () => {
    const fake = makeFakeGit();
    const deps: ApprovalDeps = {
      git: fake.git,
      branch: 'dev-agent/improve-arch-run1',
      applyRefactor: async (_path, _msg) => ({
        commitMessage: 'refactor: deepen the Inbox promote protocol',
        pr: { title: 'Deepen the Inbox promote protocol', body: 'as discussed' },
      }),
    };

    const url = await runDevAgentApproval(deps, 'go with #1');

    expect(url).toBe('https://github.com/Zabaca/cedarpad/pull/999');
    expect(fake.calls).toEqual(['prepareWorktree', 'commit', 'pushAndOpenPR', 'cleanup']);
    expect(fake.calls.filter((c) => c === 'pushAndOpenPR')).toHaveLength(1);
    expect(fake.opened!.req.title).toBe('Deepen the Inbox promote protocol');
  });

  test('no changes (clean tree) → no PR, still cleans up', async () => {
    const fake = makeFakeGit();
    fake.git.commit = async () => false; // nothing to commit
    const deps: ApprovalDeps = {
      git: fake.git,
      branch: 'dev-agent/x-run1',
      applyRefactor: async () => ({ commitMessage: 'noop', pr: { title: 't', body: 'b' } }),
    };

    const url = await runDevAgentApproval(deps, 'never mind');

    expect(url).toBeNull();
    expect(fake.calls).toContain('cleanup');
    expect(fake.calls).not.toContain('pushAndOpenPR');
  });

  test('cleanup runs even if the PR open throws', async () => {
    const fake = makeFakeGit();
    fake.git.pushAndOpenPR = async () => {
      throw new Error('gh exploded');
    };
    const deps: ApprovalDeps = {
      git: fake.git,
      branch: 'dev-agent/x-run1',
      applyRefactor: async () => ({ commitMessage: 'm', pr: { title: 't', body: 'b' } }),
    };

    await expect(runDevAgentApproval(deps, 'go')).rejects.toThrow('gh exploded');
    expect(fake.calls).toContain('cleanup');
  });
});

// ── routing ───────────────────────────────────────────────────────────────────────────

describe('isDevAgentConversation — resume routing', () => {
  test('true for a dev-agent-tagged Conversation, false otherwise', () => {
    expect(isDevAgentConversation({ workspaceId: DEV_AGENT_WORKSPACE_ID })).toBe(true);
    expect(isDevAgentConversation({ workspaceId: 'cs_workspace_abc' })).toBe(false);
    expect(isDevAgentConversation({ workspaceId: 'default' })).toBe(false);
  });
});
