// The dev-agent workflow harness (ADR-0007, PRD #51 slice #66) — the FINAL wiring that
// drives one scheduled `/improve-codebase-architecture` run end-to-end through the Inbox:
//
//   Explore → gate → ask_human (promote a Conversation) → [human approves] → PR.
//
// This is the CONTAINER-side core (Bun): it runs INSIDE the dev-agent sandbox where the
// SDK, git, and `gh` live — the edge only wakes the sandbox and kicks this (worker/dev-agent.ts).
// Every external effect (the skill's Explore phase via the SDK, the Inbox store, git/GitHub)
// is behind an INJECTED SEAM so the whole harness is hermetic under fakes — no real skill,
// agent, git, or PR is ever touched in a test.
//
// Two halves, mirroring the checkpoint-and-resume dance the Inbox is built on:
//   runDevAgentWorkflow(...)  — the scheduled half. Explore, apply the quality gate (#65),
//                               and on survivors promote EXACTLY ONE Conversation via
//                               askHuman (#61). Zero survivors → promote NOTHING (quiet run).
//   runDevAgentApproval(...)  — the resume half. When James replies to a dev-agent
//                               Conversation, this drives the chosen refactor in a fresh
//                               worktree and opens the PR (#64): prepareWorktree → commit →
//                               pushAndOpenPR → cleanup. The PR is the durable code artifact.

import { z } from 'zod';

import type { ConversationRow } from '../web-poc/lib/db/schema.ts';
import type { Candidate } from './dev-agent-gate.ts';
import { filterCandidates, readDeclinedMarkers } from './dev-agent-gate.ts';
import type { PrRequest, Worktree } from './repo-worktree.ts';

export type { Candidate } from './dev-agent-gate.ts';

// ── Contract: the explore boundary (rule #7) ──────────────────────────────────────────
//
// The skill's Explore phase runs in an SDK turn (a trust boundary: model-authored text) and
// must hand back STRUCTURED candidates. One zod schema owns that shape — the explore turn is
// instructed to emit a ```json fenced block matching it, and the harness parses+validates at
// the boundary rather than trusting free-form prose. Mirrors the #65 `Candidate` interface;
// `z.infer` keeps them from drifting.
export const CandidateSchema = z.object({
  title: z.string(),
  rationale: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  slug: z.string().optional(),
}) satisfies z.ZodType<Candidate>;

export const CandidatesSchema = z.array(CandidateSchema);

/**
 * Parse the explore turn's final text into candidates: pull the last ```json fenced block and
 * validate it against the contract. No block / invalid JSON / schema miss → [] (treated as a
 * quiet run — the harness promotes nothing rather than raising a malformed suggestion).
 */
export function parseCandidates(text: string): Candidate[] {
  const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const last = blocks.at(-1)?.[1];
  if (!last) return [];
  try {
    return CandidatesSchema.parse(JSON.parse(last));
  } catch {
    return [];
  }
}

// ── Routing: which Conversations are dev-agent workflows ──────────────────────────────
//
// A dev-agent Conversation is tagged with THIS workspace id so the Inbox reply path can
// route its resume to the PR half (runDevAgentApproval) instead of the canvas chat path.
// Disjoint from every product workspace id (which are registry ids like `cs_...` / the
// default) by construction — the same disjointness the sandbox id relies on.
export const DEV_AGENT_WORKSPACE_ID = 'dev-agent';

/** True iff this Conversation was promoted by the dev-agent (so its resume drives a PR,
 *  not a canvas chat turn). Sole routing signal — checked in the bridge reply path. */
export function isDevAgentConversation(conv: Pick<ConversationRow, 'workspaceId'>): boolean {
  return conv.workspaceId === DEV_AGENT_WORKSPACE_ID;
}

// ── Pure: candidate → Inbox promotion text ────────────────────────────────────────────

/** Assemble the `ask_human` summary + question from the surviving candidates. The summary
 *  is the one-line inbox preview; the question carries every candidate (title + rationale +
 *  severity) so James can grill/choose from the thread without re-running the skill. */
export function summarizeCandidates(survivors: Candidate[]): { summary: string; question: string } {
  const n = survivors.length;
  const summary = `${n} architecture deepening ${n === 1 ? 'candidate' : 'candidates'} to review`;
  const body = survivors
    .map((c, i) => `${i + 1}. [${c.severity}] ${c.title}\n   ${c.rationale}`)
    .join('\n\n');
  const question = [
    `A scheduled /improve-codebase-architecture run surfaced ${n} deepening ${n === 1 ? 'opportunity' : 'opportunities'} worth your call:`,
    '',
    body,
    '',
    'Reply with which (if any) to pursue — I will open a PR for the one you choose.',
  ].join('\n');
  return { summary, question };
}

// ── The scheduled half: Explore → gate → promote ──────────────────────────────────────

export interface WorkflowDeps {
  /** Repo root the run works against (for the declined-marker dedup, #65). */
  repoRoot: string;
  /** Seam over the skill's Explore/present phase: yields candidate deepenings. The default
   *  runs `/improve-codebase-architecture` via the SDK; tests inject a fake. */
  explore: () => Promise<Candidate[]>;
  /** Promote exactly ONE Inbox Conversation (#61 `askHuman`, already bound to db/session/
   *  workspace=dev-agent). Called only when survivors remain. */
  askHuman: (input: { summary: string; question: string }) => Promise<string>;
  /** Overridable for tests; default reads `docs/adr/declined/` markers off the repo. */
  readDeclined?: (repoRoot: string) => string[];
  /** Overridable for tests; default is the #65 gate. */
  filter?: (candidates: Candidate[], declined: string[]) => Candidate[];
}

/**
 * Run one scheduled dev-agent workflow: explore, apply the quality gate + declined dedup,
 * and — ONLY when survivors remain — promote a single Inbox Conversation summarizing them.
 * Zero survivors → promote NOTHING and return quietly (the quiet-run contract): a run with
 * nothing worth raising must not ping James. Returns the survivors it promoted (empty on a
 * quiet run) so the caller/log can see the outcome.
 */
export async function runDevAgentWorkflow(deps: WorkflowDeps): Promise<Candidate[]> {
  const readDeclined = deps.readDeclined ?? readDeclinedMarkers;
  const filter = deps.filter ?? filterCandidates;

  const candidates = await deps.explore();
  const survivors = filter(candidates, readDeclined(deps.repoRoot));

  if (survivors.length === 0) {
    console.log('[dev-agent] quiet run — no survivors after gate; promoting nothing');
    return [];
  }

  const { summary, question } = summarizeCandidates(survivors);
  await deps.askHuman({ summary, question });
  console.log(`[dev-agent] promoted 1 Conversation with ${survivors.length} candidate(s)`);
  return survivors;
}

// ── The resume half: approval → PR ────────────────────────────────────────────────────

/** The git seam the approval half drives — structurally satisfied by the #64 manager
 *  (`createRepoWorktreeManager`); tests inject a fake. */
export interface RepoWorktreeManager {
  prepareWorktree: (branch: string) => Promise<Worktree>;
  commit: (wt: Worktree, message: string) => Promise<boolean>;
  pushAndOpenPR: (wt: Worktree, req: PrRequest) => Promise<string>;
  cleanup: (wt: Worktree) => Promise<void>;
}

export interface ApprovalDeps {
  git: RepoWorktreeManager;
  /** The branch this run's PR lands on (from #64 `branchName(workflowId, runId)`). */
  branch: string;
  /** Seam over the agent that actually makes the chosen refactor in the worktree. Given the
   *  worktree path + James's reply, it edits the tree and returns the commit message + PR
   *  fields. The default runs the SDK against the worktree cwd; tests inject a fake. */
  applyRefactor: (worktreePath: string, humanMessage: string) => Promise<{ commitMessage: string; pr: PrRequest }>;
}

/**
 * Drive the PR half on approval: prepare a fresh worktree, let the agent apply the chosen
 * refactor, commit + push + open the PR (#64), then ALWAYS clean up the worktree. Returns
 * the PR url, or null if the refactor left the tree clean (nothing to open a PR for).
 * `pushAndOpenPR` is invoked at most once. This is what a dev-agent Conversation's resume
 * runs (routed by `isDevAgentConversation`) — NOT the canvas chat-turn path.
 */
export async function runDevAgentApproval(deps: ApprovalDeps, humanMessage: string): Promise<string | null> {
  const wt = await deps.git.prepareWorktree(deps.branch);
  try {
    const { commitMessage, pr } = await deps.applyRefactor(wt.path, humanMessage);
    const committed = await deps.git.commit(wt, commitMessage);
    if (!committed) {
      console.log('[dev-agent] approval produced no changes — no PR opened');
      return null;
    }
    const url = await deps.git.pushAndOpenPR(wt, pr);
    console.log(`[dev-agent] opened PR ${url}`);
    return url;
  } finally {
    await deps.git.cleanup(wt);
  }
}
