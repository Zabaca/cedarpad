import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { LEGACY_SANDBOX_ID } from './sandbox-resolver.ts';

// serveWorkspace is the ONE warm-proxy-first / cold-start-on-miss orchestration keyed by a
// resolved sandbox id (ADR-0009 / #122). This test pins that a Conversation's interactive
// request — dev-agent included, since ADR-0010/0011 route every Conversation (and the
// dev-agent run itself) to the warm default container — cold-starts the product interactive
// stack via the `scripts/container-start.ts` START command (vite + bridge) on the vite port
// the proxy expects.
//
// It runs through a SUBPROCESS probe (sandbox-runtime.boot-probe.ts): two sibling worker test files
// wholesale-mock `./sandbox-runtime.ts` via bun's process-global mock registry, which leaks across
// files and would hand us their stub instead of the real serveWorkspace. A fresh `bun` process is
// the clean isolation; the probe stubs `@cloudflare/sandbox` and reports what the boot asked of the
// container as JSON.

interface BootProbe {
  status: number;
  getSandboxIds: string[];
  started: string[];
  waited: number[];
  exposed: number[];
}

function runBootProbe(): BootProbe {
  const res = Bun.spawnSync(['bun', 'run', join(import.meta.dir, 'sandbox-runtime.boot-probe.ts')], {
    stderr: 'inherit',
  });
  const out = res.stdout.toString();
  const line = out.split('\n').find((l) => l.startsWith('__BOOT_PROBE__'));
  if (!line) throw new Error(`boot probe produced no result:\n${out}`);
  return JSON.parse(line.slice('__BOOT_PROBE__'.length)) as BootProbe;
}

describe('serveWorkspace: an interactive request boots the product interactive stack (ADR-0010)', () => {
  test('a cold interactive request boots the product interactive stack (container-start), keyed by the warm default container id', () => {
    const probe = runBootProbe();

    // The proxy served through after the cold boot.
    expect(probe.status).toBe(200);
    // Keyed by the warm default container — the one every Conversation resumes on now.
    expect(probe.getSandboxIds).toContain(LEGACY_SANDBOX_ID);
    // It booted the SAME interactive stack the product container runs — the container-start
    // entry that launches vite + bridge.
    expect(probe.started).toHaveLength(1);
    expect(probe.started[0]).toContain('scripts/container-start.ts');
    // …reachable on the vite/bridge port the edge proxy forwards to (4510).
    expect(probe.waited).toContain(4510);
    expect(probe.exposed).toContain(4510);
  });
});

// #138: a page load fires ~40 requests at a sleeping container at once. Before single-flighting the
// cold path, each ran its own ensureStack (kill+startProcess) and they canceled each other's vite
// process, so the container never came up. This pins that N concurrent cold requests boot the
// container exactly ONCE.
interface StampedeProbe {
  statuses: number[];
  started: number;
  exposed: number;
}

function runStampedeProbe(): StampedeProbe {
  const res = Bun.spawnSync(['bun', 'run', join(import.meta.dir, 'sandbox-runtime.stampede-probe.ts')], { stderr: 'inherit' });
  const out = res.stdout.toString();
  const line = out.split('\n').find((l) => l.startsWith('__STAMPEDE_PROBE__'));
  if (!line) throw new Error(`stampede probe produced no result:\n${out}`);
  return JSON.parse(line.slice('__STAMPEDE_PROBE__'.length)) as StampedeProbe;
}

describe('serveWorkspace: concurrent cold requests single-flight one boot (#138)', () => {
  test('8 concurrent cold requests start the container once and all serve', () => {
    const probe = runStampedeProbe();
    // The whole point: one boot, not one-per-request — no more mutual cancellation.
    expect(probe.started).toBe(1);
    expect(probe.exposed).toBe(1);
    // Every concurrent request still gets served through the shared boot.
    expect(probe.statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
  });
});
