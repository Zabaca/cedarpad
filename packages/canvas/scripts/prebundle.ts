// Bake vite's dependency pre-bundle (`node_modules/.vite/deps`) into the image. Run once, as the last build step of
// the sandbox form of the Dockerfile; nothing else calls it.
//
// Why: a cold vite with no pre-bundle makes one on the first page load, 6 s of it, and a page load that races it gets
// a chunk that is not written yet and a blank canvas (2026-08-14; the reason the workspace left Cloudflare, see
// worker/self-hosted.ts). A sandbox that starts fresh (a restart of its machine, a replaced image) has only what the
// image carries, so the image carries the pre-bundle: vite reuses it at start (the same hash, a first page load of
// 0.8 s in the spike on 2026-11-09). A sandbox that merely sleeps keeps its whole disk and needs none of this.
//
// How: start vite as the stack does, load the pad's entry module so the optimizer runs (that request waits for it),
// wait until the cache stops changing, stop vite, and remove the temporary files vite leaves. It fails the build
// rather than baking an image with no pre-bundle in it.
export {};

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // package root, trailing slash
const PORT = process.env.PORT ?? '4510';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const DEPS = `${ROOT}node_modules/.vite/deps`;
const METADATA = `${DEPS}/_metadata.json`;
const ENTRY = '/src/main.tsx'; // index.html's one script

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// `bun run dev:web` is how the stack starts vite (scripts/dev.ts), so the config and the environment are the same.
const vite = Bun.spawn(['bun', 'run', 'dev:web'], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT } });

const die = (why: string): never => {
  console.error(`[prebundle] ${why}`);
  vite.kill('SIGKILL');
  process.exit(1);
};

async function waitFor<T>(what: string, seconds: number, probe: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) die(`vite exited (${vite.exitCode}) while waiting for ${what}`);
    const got = await probe().catch(() => null);
    if (got !== null) return got;
    await sleep(250);
  }
  return die(`gave up waiting for ${what} after ${seconds}s`);
}

const metadata = () => (existsSync(METADATA) ? readFileSync(METADATA, 'utf8') : null);

try {
  await waitFor('vite to answer', 60, async () => ((await fetch(`${ORIGIN}/`)).ok ? true : null));

  const entry = await fetch(`${ORIGIN}${ENTRY}`, { signal: AbortSignal.timeout(120_000) });
  if (!entry.ok) die(`${ENTRY} answered ${entry.status}`);
  await entry.arrayBuffer();

  // The optimizer may still be writing after the request that started it returns: done is a cache that has held
  // still for two seconds.
  let last = '';
  let steady = 0;
  await waitFor('the pre-bundle to settle', 120, async () => {
    const now = metadata() ?? '';
    steady = now !== '' && now === last ? steady + 1 : 0;
    last = now;
    return steady >= 8 ? true : null;
  });
} finally {
  console.log('[prebundle] stopping vite (bun reports its SIGTERM as "exited with code 143")');
  vite.kill('SIGTERM');
  await vite.exited;
}

if (!existsSync(METADATA)) die('vite wrote no pre-bundle');
// What vite leaves that is no part of the pre-bundle: a half-written optimizer pass, and the bundled copy of its config.
for (const leftover of readdirSync(`${ROOT}node_modules/.vite`).filter((f) => f.startsWith('deps_temp_'))) {
  rmSync(`${ROOT}node_modules/.vite/${leftover}`, { recursive: true, force: true });
}
rmSync(`${ROOT}node_modules/.vite-temp`, { recursive: true, force: true });

const files = readdirSync(DEPS).filter((f) => statSync(`${DEPS}/${f}`).isFile()).length;
const hash = (JSON.parse(readFileSync(METADATA, 'utf8')) as { browserHash?: string }).browserHash;
console.log(`[prebundle] ${files} files in node_modules/.vite/deps, browserHash ${hash}`);
