// Container entry: restore the workspace from R2, then run the dev stack. The
// Worker starts this via the sandbox `startProcess`. Order matters — the overlay
// (every file the agent authored) must land on disk BEFORE vite/bridge start so
// they serve the restored tree; the bridge then loads canvas-state itself.
// Local dev uses scripts/dev.ts directly; this path only runs in the container.
export {};

import { fileURLToPath } from 'node:url';

import { BlobStore, selectBackend } from '../server/blob-store.ts';
import { extractCanvasDirs, extractOverlay } from '../server/overlay.ts';

// Cold-boot phase timing — read via the Worker's /__bootlog (CF doesn't stream
// container stdout to Workers Observability yet). t0 ≈ container-process start.
const t0 = Date.now();
const ms = () => `+${Date.now() - t0}ms`;

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
const WORKSPACE = process.env.CANVAS_WORKSPACE ?? 'default';
// Claude session transcripts (~/.claude/projects); synced on their own so `resume`
// survives a recycle.
const SESSIONS = `${process.env.HOME ?? '/root'}/.claude/projects`;
// Workspace skills (ADR-0013): user-/agent-authored skill dirs under the package's
// .claude/skills, discovered by the SDK's 'project' source. Same persistence model as
// components. Platform skills live at ~/.claude/skills (image-only) instead.
const SKILLS = `${ROOT}.claude/skills`;
const store = new BlobStore(selectBackend(`${ROOT}.persist`)); // R2_BUCKET set in-container
console.log(
  `[boot] env present: R2_BUCKET=${!!process.env.R2_BUCKET} R2_ACCESS_KEY_ID=${!!process.env.R2_ACCESS_KEY_ID} CLAUDE_CODE_OAUTH_TOKEN=${!!process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
);

// ADR-0014: the two live component trees (platform base `src/canvas-components/` is
// image-only and never restored from R2).
const SHARED_COMPONENTS = `${ROOT}shared/components`;
await Bun.spawn(['mkdir', '-p', SHARED_COMPONENTS]).exited;
const sharedComponents = await store.loadSharedComponents(WORKSPACE).catch((err) => {
  console.error('[boot] shared components load failed; starting with none:', err);
  return null;
});
if (sharedComponents) {
  await extractOverlay(sharedComponents, SHARED_COMPONENTS);
  console.log(`[boot] ${ms()} shared component library restored from R2`);
}

const SRC_ROOT = `${ROOT}src`;
const canvasDirs = await store.loadCanvasDirs(WORKSPACE).catch((err) => {
  console.error('[boot] per-canvas component dirs load failed; starting with none:', err);
  return null;
});
if (canvasDirs) {
  await extractCanvasDirs(canvasDirs, SRC_ROOT);
  console.log(`[boot] ${ms()} per-canvas component dirs restored from R2`);
}

// Restore workspace skills. mkdir first: the dir won't exist in the image (skills are
// workspace content, not baked) and extract needs it.
await Bun.spawn(['mkdir', '-p', SKILLS]).exited;
const skills = await store.loadSkills(WORKSPACE).catch((err) => {
  console.error('[boot] workspace skills load failed; starting with none:', err);
  return null;
});
if (skills) {
  await extractOverlay(skills, SKILLS);
  console.log(`[boot] ${ms()} workspace skills restored from R2`);
}

// Restore Claude session transcripts so `resume` finds the JSONL after a recycle.
// mkdir first: the dir may not exist on a first boot, and tar/extract/watch need it.
await Bun.spawn(['mkdir', '-p', SESSIONS]).exited;
const sessions = await store.loadSessions(WORKSPACE).catch((err) => {
  console.error('[boot] sessions load failed; starting with none:', err);
  return null;
});
if (sessions) {
  await extractOverlay(sessions, SESSIONS);
  console.log(`[boot] ${ms()} Claude sessions restored from R2`);
}

// Subsequent component / skill / session edits persist back to R2 at TURN-COMPLETION,
// in-process in the bridge (ADR 0003) — no fs.watch (its recursive mode threw EINVAL on
// Linux and silently disabled the sessions sync, breaking resume across a recycle). The
// boot restore above is the only filesystem work here now.

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
await dev.exited;
