import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { appendUtterance, transcriptPath } from './transcript.ts';

// ADR-0017: the per-speaker transcript is a byproduct of listening — one JSONL line per
// finalized utterance. Audio is never recorded.
describe('huddle transcript — JSONL append', () => {
  test('finalized utterances append {speaker, ts, text} lines, readable back in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'huddle-'));
    const file = transcriptPath(dir, 'cv_1');
    appendUtterance(file, { speaker: 'james', ts: 1000, text: 'ship variant two' });
    appendUtterance(file, { speaker: 'cedar', ts: 2000, text: 'placing it now' });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { speaker: 'james', ts: 1000, text: 'ship variant two' },
      { speaker: 'cedar', ts: 2000, text: 'placing it now' },
    ]);
    expect(file).toContain('cv_1');
  });
});
