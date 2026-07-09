// The dev-agent workflow harness (ADR-0007, PRD #51 slice #66) — the FINAL wiring that
// drives one scheduled `/improve-codebase-architecture` run end-to-end through the Inbox:
//
//   Explore → gate → ask_human (promote a Conversation) → [grill in-thread] → open_pr tool.
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
//   openDevAgentPr(...)       — the PR half, now an IN-CONVERSATION TOOL (ADR-0009 Tier 2,
//                               #126). A dev-agent reply is a normal chat turn (no approval
//                               special-case); when the agent is aligned with James it invokes
//                               the `open_pr` tool, which commits the runner's OWN worktree and
//                               opens the PR (#64): commit → pushAndOpenPR. The PR is the durable
//                               code artifact — the agent supplies its title/body/commit message
//                               from the thread it is in, so nothing is reconstructed.

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
// A dev-agent Conversation is tagged with THIS workspace id: it homes on the dev-agent's OWN
// sandbox (equal to `DEV_AGENT_SANDBOX_ID`), whose interactive bridge exposes the `open_pr`
// tool. Disjoint from every product workspace id (which are registry ids like `cs_...` / the
// default) by construction — the same disjointness the sandbox id relies on. Under ADR-0009
// a dev-agent reply is a normal chat turn (no reply special-case); this id is how the edge
// proxy routes to the right bridge and how that bridge decides to offer `open_pr`.
export const DEV_AGENT_WORKSPACE_ID = 'dev-agent';

/** True iff this Conversation was promoted by the dev-agent (so it is grilled as a chat and
 *  opens its PR via the `open_pr` tool). The dev-agent routing predicate. */
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

// ── The PR half: the `open_pr` tool ───────────────────────────────────────────────────

/** The git seam — structurally satisfied by the #64 manager (`createRepoWorktreeManager`);
 *  tests inject a fake. `prepareWorktree`/`cleanup` are the batch-run lifecycle; the in-
 *  conversation `open_pr` tool only ever `commit`s + `pushAndOpenPR`s the runner's own tree. */
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
 * The `open_pr` tool body (ADR-0009 Tier 2, #126): commit the runner's worktree with the
 * agent-supplied message and open the PR (#64). Returns the PR url, or null if the tree was
 * clean (nothing to open a PR for). The agent — grilling James in-thread — supplies the PR
 * title/body + commit message from the conversation it is in, so no summary+reply bundle is
 * reconstructed. This replaces the old reply-time approval special-case: a dev-agent reply is
 * now a plain chat turn, and THIS is a tool the agent chooses to call when aligned.
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
