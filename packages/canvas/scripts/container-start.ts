// Container entry: run the dev stack. The Worker starts this via the sandbox
// `startProcess`. Local dev uses scripts/dev.ts directly; this path only runs in the
// container.
//
// IT RESTORES NOTHING (#366, ADR-0022 decision 5). Workspace content — Components, their
// data files, Workspace skills — is Records in D1, and the filesystem is a RENDERING of
// them: a Component materializes when vite asks for the module (server/materialize.ts), and
// the skill tree is rendered once per turn, before the SDK scans it (server/skills.ts).
// Transcripts are Files, and the ONE a chat resumes is fetched by the turn that resumes it
// (`TranscriptStore.materialize`).
//
// The restore this file used to do was the first half of the 2026-07-29 loss: it read three
// tarballs, swallowed any failure with a log line and a null, and left the container serving
// an empty tree that the next full-replace flush wrote over the only copy. It also inverted
// the model — resolution is file-first, so a tarball landing on disk at boot would shadow a
// newer Record on every cold boot. Deleting the step deletes both, which is why decision 5
// removes it rather than guarding it. `server/boot-contract.test.ts` keeps it deleted.
export {};

import { fileURLToPath } from 'node:url';

// Cold-boot phase timing — read via the Worker's /__bootlog (CF doesn't stream
// container stdout to Workers Observability yet). t0 ≈ container-process start.
const t0 = Date.now();
const ms = () => `+${Date.now() - t0}ms`;

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
console.log(
  `[boot] env present: WORKSPACE_KEY=${!!process.env.WORKSPACE_KEY} WORKSPACE_BLOBS=${process.env.WORKSPACE_BLOBS ?? 'unset'} CLAUDE_CODE_OAUTH_TOKEN=${!!process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
);

// Run the dev stack (vite :4510 + bridge :4511); take the process down with it.
console.log(`[boot] ${ms()} starting dev stack (vite + bridge)`);
const dev = Bun.spawn(['bun', 'run', 'scripts/dev.ts'], {
  cwd: ROOT,
  stdio: ['inherit', 'inherit', 'inherit'],
});
const down = () => {
  dev.kill();
  process.exit(0);
};
process.on('SIGINT', down);
process.on('SIGTERM', down);

// EXIT WITH THE CAUSE, NOT WITH 0 (incident 2026-08-13). Falling off the end here exited 0
// no matter how the stack died, so every failed boot reached the Worker as
// `ProcessExitedBeforeReadyError: Process exited with code 0` — a message that can never
// name what happened, and reads like a clean shutdown. Only a signal reaches `down()` above;
// getting HERE means the dev stack died on its own, which is always a failure, so a 0 from
// it is still reported as one. The reason itself is in the lines above this one (dev.ts logs
// which child died) — read them with `/__bootlog`.
const code = await dev.exited;
console.error(`[boot] ${ms()} dev stack exited (code ${code}) — see the lines above for which child died`);
process.exit(code || 1);
