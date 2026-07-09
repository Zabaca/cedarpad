import { describe, expect, test } from 'bun:test';

import type { Candidate } from './dev-agent-gate.ts';
import type { PrRequest, Worktree } from './repo-worktree.ts';
import {
  DEV_AGENT_WORKSPACE_ID,
  type OpenPrDeps,
  type WorkflowDeps,
  isDevAgentConversation,
  openDevAgentPr,
  parseCandidates,
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

describe('isDevAgentConversation — dev-agent routing predicate', () => {
  test('true for a dev-agent-tagged Conversation, false otherwise', () => {
    expect(isDevAgentConversation({ workspaceId: DEV_AGENT_WORKSPACE_ID })).toBe(true);
    expect(isDevAgentConversation({ workspaceId: 'cs_workspace_abc' })).toBe(false);
    expect(isDevAgentConversation({ workspaceId: 'default' })).toBe(false);
  });
});
