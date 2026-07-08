import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  type Candidate,
  DECLINED_MARKERS_DIR,
  candidateSlug,
  declinedMarkerSlug,
  filterCandidates,
  isDeclined,
  meetsBar,
  readDeclinedMarkers,
} from './dev-agent-gate.ts';

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  title: 'Consolidate the sandbox resolver',
  rationale: 'Understanding one wake needs bouncing across three modules.',
  severity: 'high',
  ...over,
});

describe('quality bar', () => {
  test('above-bar candidates pass (medium and high)', () => {
    expect(meetsBar(candidate({ severity: 'medium' }))).toBe(true);
    expect(meetsBar(candidate({ severity: 'high' }))).toBe(true);
  });

  test('below-bar candidates are dropped (severity under the bar)', () => {
    expect(meetsBar(candidate({ severity: 'low' }))).toBe(false);
  });

  test('missing required fields (title / rationale) fail the bar', () => {
    expect(meetsBar(candidate({ title: '   ' }))).toBe(false);
    expect(meetsBar(candidate({ rationale: '' }))).toBe(false);
  });

  test('filterCandidates keeps above-bar, drops below-bar', () => {
    const above = candidate({ title: 'Keep me', severity: 'high' });
    const below = candidate({ title: 'Drop me', severity: 'low' });
    expect(filterCandidates([above, below], [])).toEqual([above]);
  });
});

describe('dedup against declined markers', () => {
  test('candidate identity comes from explicit slug, else the title', () => {
    expect(candidateSlug(candidate({ slug: 'Sandbox Resolver!' }))).toBe('sandbox-resolver');
    expect(candidateSlug(candidate({ slug: undefined, title: 'Merge Auth Gate' }))).toBe('merge-auth-gate');
  });

  test('a candidate matching a declined marker is dropped', () => {
    const c = candidate({ slug: 'merge-inbox-and-shell' });
    expect(isDeclined(c, ['merge-inbox-and-shell'])).toBe(true);
    expect(filterCandidates([c], ['merge-inbox-and-shell'])).toEqual([]);
  });

  test('a near-but-distinct candidate is NOT dropped', () => {
    const declined = ['merge-inbox-and-shell'];
    const near = candidate({ slug: 'merge-inbox-and-canvas' });
    expect(isDeclined(near, declined)).toBe(false);
    expect(filterCandidates([near], declined)).toEqual([near]);
  });
});

describe('bar + dedup compose', () => {
  test('a below-bar declined candidate is dropped (either reason suffices)', () => {
    const c = candidate({ slug: 'old-idea', severity: 'low' });
    expect(filterCandidates([c], ['old-idea'])).toEqual([]);
  });

  test('mixed set: only above-bar, not-declined survivors remain', () => {
    const keep = candidate({ slug: 'keep', severity: 'medium' });
    const belowBar = candidate({ slug: 'weak', severity: 'low' });
    const declined = candidate({ slug: 'nope', severity: 'high' });
    expect(filterCandidates([keep, belowBar, declined], ['nope'])).toEqual([keep]);
  });

  test('empty survivor set → empty (caller promotes nothing)', () => {
    expect(filterCandidates([], [])).toEqual([]);
    const allDropped = [candidate({ slug: 'a', severity: 'low' }), candidate({ slug: 'b' })];
    expect(filterCandidates(allDropped, ['b'])).toEqual([]);
  });
});

describe('declined marker filenames → slugs', () => {
  test('strips .md and an optional NNNN- prefix', () => {
    expect(declinedMarkerSlug('merge-inbox-and-shell.md')).toBe('merge-inbox-and-shell');
    expect(declinedMarkerSlug('0003-merge-inbox-and-shell.md')).toBe('merge-inbox-and-shell');
  });
});

describe('readDeclinedMarkers (thin fs reader)', () => {
  test('missing dir → no markers', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-'));
    expect(readDeclinedMarkers(root)).toEqual([]);
  });

  test('lists .md marker slugs from docs/adr/declined', () => {
    const root = mkdtempSync(join(tmpdir(), 'gate-'));
    const dir = join(root, DECLINED_MARKERS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '0001-merge-inbox-and-shell.md'), '# declined');
    writeFileSync(join(dir, 'split-the-bridge.md'), '# declined');
    writeFileSync(join(dir, 'README.txt'), 'not a marker');

    const markers = readDeclinedMarkers(root).sort();
    expect(markers).toEqual(['merge-inbox-and-shell', 'split-the-bridge']);

    // end-to-end: a candidate whose slug matches a read marker is deduped.
    const c = candidate({ slug: 'split-the-bridge' });
    expect(filterCandidates([c], markers)).toEqual([]);
  });
});
