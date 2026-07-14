// Where a session's SDK JSONL lives on the runner — the one home for that knowledge.
// The SDK writes ~/.claude/projects/<projectDirForCwd(cwd)>/<sessionId>.jsonl and `resume`
// reads it back from that exact cwd-scoped path (#133). Two facts about a session's JSONL are
// needed all over the transcript/resume code: the EXACT path resume expects (restore + adopt
// must land the file there), and a nesting-robust LOOKUP (`**/<sessionId>.jsonl`) for reading
// history and for adoption. Both were re-inlined across transcript-r2.ts and
// session-transcript.ts; concentrating them here means a change to the SDK's on-disk layout
// touches one module.

import { join } from 'node:path';

/** The SDK's on-disk project-dir name for a cwd. Claude Code encodes the absolute cwd into a
 * single dir segment by replacing every NON-ALPHANUMERIC character with `-` (verified against
 * the CLI: `.../under_score_test` → `...-under-score-test`). A narrower `[/.]` rule shipped a
 * live resume failure once the per-repo worktree root (`Zabaca__cedarpad`, ADR-0015) introduced
 * underscores: adopt landed the JSONL in a dir the SDK never reads. */
export const projectDirForCwd = (cwd: string): string => cwd.replace(/[^a-zA-Z0-9]/g, '-');

/** The exact on-disk path `query({ resume, cwd })` reads for a session:
 * `<projectsDir>/<projectDirForCwd(cwd)>/<sessionId>.jsonl`. Restore + adopt must land the
 * file here verbatim. */
export const resumeJsonlPath = (projectsDir: string, cwd: string, sessionId: string): string =>
  join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`);

/** Locate a session's JSONL anywhere under `projectsDir`, robust to flat vs cwd-hash nesting
 * (globs `**\/<sessionId>.jsonl`). Returns every absolute match (usually one; adoption relies
 * on seeing all copies); an empty array when absent. Throws only if `projectsDir` can't be
 * scanned (e.g. a fresh cold container with no projects dir) — callers that treat "not present"
 * as non-fatal catch it. */
export async function findSessionJsonl(projectsDir: string, sessionId: string): Promise<string[]> {
  const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
  const found: string[] = [];
  for await (const path of glob.scan({ cwd: projectsDir, absolute: true })) found.push(path);
  return found;
}
