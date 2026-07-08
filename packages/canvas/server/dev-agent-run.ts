// The dev-agent container entrypoint (ADR-0007, PRD #51 slice #66). The edge wakes the
// dev-agent sandbox and execs this (worker/dev-agent.ts → `runDevAgent`); here — inside the
// container, where the SDK/Turso/git live — it assembles the PRODUCTION seams for the
// scheduled half of `runDevAgentWorkflow` (Explore → gate → ask_human):
//
//   • explore   — one SDK turn running `/improve-codebase-architecture`'s Explore/present
//                 phase, instructed to emit the candidates as the contract's ```json block.
//   • askHuman  — #61, bound to remote Turso + the explore session's id + workspace=dev-agent,
//                 so James's later reply resumes THIS Conversation down the PR path.
//
// Pure assembly of external effects — untested by design (the harness + parser + gate it
// composes are the unit-tested cores). Runs only as a script (`import.meta.main`).

import { query } from '@anthropic-ai/claude-agent-sdk';
import { createClient } from '@libsql/client';

import { conversations, makeDb } from '../web-poc/lib/db/index.ts';
import { askHuman } from './inbox.ts';
import { DEV_AGENT_WORKSPACE_ID, parseCandidates, runDevAgentWorkflow } from './dev-agent-workflow.ts';

async function main(): Promise<void> {
  const repoRoot = process.env.DEV_AGENT_REPO_ROOT ?? process.cwd();
  const userId = process.env.DEV_AGENT_USER_ID;
  if (!userId) throw new Error('DEV_AGENT_USER_ID is not set — cannot promote a Conversation to the human');

  const db = makeDb(
    createClient(
      process.env.TURSO_URL && process.env.TURSO_KEY
        ? { url: process.env.TURSO_URL, authToken: process.env.TURSO_KEY }
        : { url: process.env.TURSO_URL ?? 'file:.dev-agent.db' },
    ),
  );

  // Run the skill's Explore phase once, capturing the session id (so the promoted Conversation
  // resumes THIS session) and the final text (parsed into candidates at the contract boundary).
  let sessionId: string | null = null;
  let finalText = '';
  const prompt = [
    'Run the Explore and Present-candidates phases of /improve-codebase-architecture on this repo.',
    'Do NOT propose interfaces or make edits. After presenting the numbered candidates, emit them as',
    'a single ```json fenced block: an array of { title, rationale, severity: "low"|"medium"|"high" }.',
  ].join(' ');
  for await (const m of query({
    prompt,
    options: {
      cwd: repoRoot,
      permissionMode: 'bypassPermissions',
      settingSources: ['user', 'project'],
      skills: ['improve-codebase-architecture'],
      maxTurns: 50,
    },
  })) {
    if (m.type === 'system' && 'session_id' in m) sessionId = m.session_id ?? sessionId;
    if (m.type === 'result') {
      sessionId = m.session_id ?? sessionId;
      if (m.subtype === 'success') finalText = m.result;
    }
  }

  const candidates = parseCandidates(finalText);

  await runDevAgentWorkflow({
    repoRoot,
    explore: async () => candidates,
    askHuman: (input) =>
      askHuman(
        { db, getSessionId: () => sessionId, userId, workspaceId: DEV_AGENT_WORKSPACE_ID, notify: (c, q) => console.log(`[dev-agent] notify ${c.id}: ${q}`) },
        input,
      ),
  });
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[dev-agent] workflow run failed: ${String((e as Error)?.stack ?? e)}`);
    process.exit(1);
  });
}
