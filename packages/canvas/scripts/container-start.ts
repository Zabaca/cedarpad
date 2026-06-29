// Container entry: restore the workspace from R2, then run the dev stack. The
// Worker starts this via the sandbox `startProcess`. Order matters — the overlay
// (every file the agent authored) must land on disk BEFORE vite/bridge start so
// they serve the restored tree; the bridge then loads canvas-state itself.
// Local dev uses scripts/dev.ts directly; this path only runs in the container.
export {};

import { fileURLToPath } from 'node:url';

import { BlobStore, selectBackend } from '../server/blob-store.ts';
import { extractOverlay } from '../server/overlay.ts';

// Cold-boot phase timing — read via the Worker's /__bootlog (CF doesn't stream
// container stdout to Workers Observability yet). t0 ≈ container-process start.
const t0 = Date.now();
const ms = () => `+${Date.now() - t0}ms`;

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
const WORKSPACE = process.env.CANVAS_WORKSPACE ?? 'default';
// The agent's durable output is JUST its component library (a flat dir of .tsx).
// Persisting only this — not the whole app subtree — keeps OUR app code image-only
// (deploys can't be shadowed). Saved back at turn-completion by the bridge (ADR 0003).
// Our seed components ship in the image; the saved tar (once any exist) is the full
// library and replaces them.
const COMPONENTS = `${ROOT}src/canvas-components`;
// The agent's backend extension: custom handlers (a flat dir of .ts), run by the
// isolated extension server. Same persistence model as components — extension
// content, image-only core (ADR 0002).
const CUSTOM = `${ROOT}server/custom`;
// Claude session transcripts (~/.claude/projects); synced on their own so `resume`
// survives a recycle.
const SESSIONS = `${process.env.HOME ?? '/root'}/.claude/projects`;
const store = new BlobStore(selectBackend(`${ROOT}.persist`)); // R2_BUCKET set in-container
console.log(
  `[boot] env present: R2_BUCKET=${!!process.env.R2_BUCKET} R2_ACCESS_KEY_ID=${!!process.env.R2_ACCESS_KEY_ID} CLAUDE_CODE_OAUTH_TOKEN=${!!process.env.CLAUDE_CODE_OAUTH_TOKEN}`,
);

// Boot restore: replace the component library with the saved one (if any). Honors
// deletions (the tar IS the full library). The image's seed components are the
// baseline when nothing's saved yet.
const components = await store.loadComponents(WORKSPACE).catch((err) => {
  console.error('[boot] component library load failed; using image seed:', err);
  return null;
});
if (components) {
  await extractOverlay(components, COMPONENTS);
  console.log(`[boot] ${ms()} component library restored from R2`);
} else {
  console.log(`[boot] ${ms()} no saved components; using image seed library`);
}

// Same for the custom-handler library (the agent's backend extension).
const custom = await store.loadCustom(WORKSPACE).catch((err) => {
  console.error('[boot] custom handlers load failed; using image seed:', err);
  return null;
});
if (custom) {
  await extractOverlay(custom, CUSTOM);
  console.log(`[boot] ${ms()} custom handlers restored from R2`);
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

// Subsequent component / custom / session edits persist back to R2 at TURN-COMPLETION,
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
