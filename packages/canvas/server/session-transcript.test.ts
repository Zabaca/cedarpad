import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

import { loadSessionTranscript, projectTranscript } from './session-transcript.ts';

// On-disk JSONL records: {type, message, ...} with the same `message` shape classify reads.
const asst = (content: unknown[]): SDKMessage =>
  ({ type: 'assistant', message: { role: 'assistant', content } }) as unknown as SDKMessage;
const usr = (text: string): SDKMessage =>
  ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) as unknown as SDKMessage;
const resultLine = (sessionId: string, cost: number): SDKMessage =>
  ({ type: 'result', subtype: 'success', session_id: sessionId, total_cost_usd: cost }) as unknown as SDKMessage;

describe('projectTranscript', () => {
  test('S3 folds a user→agent→tool conversation into ordered replay events', () => {
    const msgs: SDKMessage[] = [
      usr('draw a box'),
      asst([{ type: 'text', text: 'on it' }, { type: 'tool_use', name: 'mcp__canvas__create_shapes', input: { n: 1 }, id: 'tu_1' }]),
    ];
    expect(projectTranscript(msgs)).toEqual([
      { kind: 'delta', text: 'draw a box', role: 'user' },
      { kind: 'delta', text: 'on it' },
      { kind: 'tool', name: 'create_shapes', input: { n: 1 }, id: 'tu_1' },
    ]);
  });

  test('S3b a result line folds but emits no chip', () => {
    expect(projectTranscript([resultLine('s1', 0.42)])).toEqual([]);
  });
});

describe('loadSessionTranscript', () => {
  test('S4 globs **/<sessionId>.jsonl, parses lines, projects (robust to nesting)', async () => {
    const root = join(tmpdir(), `Tmp_SessionTranscript_${process.pid}`);
    const nested = join(root, '-some-cwd-hash');
    try {
      mkdirSync(nested, { recursive: true });
      const sessionId = 'sess-abc';
      const lines = [
        { type: 'ai-title', aiTitle: 'x', sessionId }, // CLI metadata: no events
        { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
        { type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent noise' }] } }, // filtered
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ];
      await Bun.write(join(nested, `${sessionId}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
      expect(await loadSessionTranscript(root, sessionId)).toEqual([
        { kind: 'delta', text: 'hi', role: 'user' },
        { kind: 'delta', text: 'hello' },
      ]);
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });

  test('S5 an absent session file → [] (not an error)', async () => {
    const root = join(tmpdir(), `Tmp_SessionTranscript_absent_${process.pid}`);
    try {
      mkdirSync(root, { recursive: true });
      expect(await loadSessionTranscript(root, 'nope')).toEqual([]);
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
