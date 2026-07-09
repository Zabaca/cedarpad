import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { DEV_AGENT_SANDBOX_ID } from './dev-agent.ts';

// serveWorkspace is the ONE warm-proxy-first / cold-start-on-miss orchestration keyed by a
// resolved sandbox id (ADR-0009 / #122). This test pins the Tier-2 (#125) fact that the dev-agent
// sandbox — when woken for an INTERACTIVE request proxied to it by the edge chat proxy — boots the
// SAME interactive stack the product container runs: it cold-starts via the product
// `scripts/container-start.ts` START command (vite + bridge) on the vite port the proxy expects,
// NOT the fire-and-forget batch workflow (`server/dev-agent-run.ts`).
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

describe('serveWorkspace: the dev-agent sandbox boots the interactive bridge (ADR-0009 Tier 2 / #125)', () => {
  test('a cold interactive request to the dev-agent runner boots the product interactive stack (container-start), keyed by the dev-agent sandbox id', () => {
    const probe = runBootProbe();

    // The proxy served through after the cold boot.
    expect(probe.status).toBe(200);
    // Keyed by the dev-agent's OWN sandbox id — not a derived `workspace-dev-agent` container.
    expect(probe.getSandboxIds).toContain(DEV_AGENT_SANDBOX_ID);
    // It booted the SAME interactive stack the product container runs — the container-start entry
    // that launches vite + bridge — NOT the batch workflow entry (dev-agent-run.ts).
    expect(probe.started).toHaveLength(1);
    expect(probe.started[0]).toContain('scripts/container-start.ts');
    expect(probe.started[0]).not.toContain('dev-agent-run.ts');
    // …reachable on the vite/bridge port the edge proxy forwards to (4510).
    expect(probe.waited).toContain(4510);
    expect(probe.exposed).toContain(4510);
  });
});
