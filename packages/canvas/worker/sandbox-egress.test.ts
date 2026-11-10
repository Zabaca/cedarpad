import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

// `sbx egress <name> allow` only adds, so removing a host from sandbox/workspace.env left it reachable on a
// sandbox that already existed (the R2 host, once a container no longer reaches R2). The deploy now removes
// the sandbox's own additions that the declaration does not list; this is the selection, run through bash.

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'sandbox-egress.sh');
const R2 = '99a19e584439be0568f33aad0477372b.r2.cloudflarestorage.com';

/** What `sbx egress <name>` prints (scripts/deploy-sandbox.sh reads it), for a sandbox with these additions. */
const listing = (own: string[], site = ['api.example.test', '*.registry.example.test']) =>
  [
    'cedarpad-default may reach (the site\'s list, then its own additions):',
    ...site.map((h) => `  ${h}`),
    ...own.map((h) => `  ${h}   (this sandbox only)`),
    'no connections open now',
  ].join('\n');

function stale(declared: string, output: string): string[] {
  const run = Bun.spawnSync(['bash', '-c', `source "$1"; stale_egress "$2"`, 'bash', SCRIPT, declared], { stdin: new TextEncoder().encode(output) });
  expect(run.exitCode).toBe(0);
  return new TextDecoder().decode(run.stdout).split('\n').filter(Boolean);
}

describe('stale_egress', () => {
  test('an addition the declaration dropped is stale: the R2 host after its removal from workspace.env', () => {
    expect(stale('app.cedarpad.com www.fredrin.com', listing(['app.cedarpad.com', R2, 'www.fredrin.com']))).toEqual([R2]);
  });

  test('nothing is stale when the sandbox has exactly what is declared', () => {
    expect(stale('app.cedarpad.com www.fredrin.com', listing(['app.cedarpad.com', 'www.fredrin.com']))).toEqual([]);
  });

  test('the site-wide list is never selected, even though none of it is declared', () => {
    expect(stale('app.cedarpad.com', listing(['app.cedarpad.com'], ['api.example.test', 'old-site-host.example.test']))).toEqual([]);
  });

  test('every dropped host is selected, and a sandbox with no additions has none', () => {
    expect(stale('', listing(['a.example.test', 'b.example.test:443']))).toEqual(['a.example.test', 'b.example.test:443']);
    expect(stale('app.cedarpad.com', listing([]))).toEqual([]);
  });

  test('a host that only contains a declared one is still stale (no substring match)', () => {
    expect(stale('app.cedarpad.com', listing(['app.cedarpad.com.evil.test', 'xapp.cedarpad.com']))).toEqual(['app.cedarpad.com.evil.test', 'xapp.cedarpad.com']);
  });

  test('empty output selects nothing', () => {
    expect(stale('app.cedarpad.com', '')).toEqual([]);
  });
});
