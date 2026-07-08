import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memBackend } from './blob-store.ts';
import { backup, projectDirForCwd, read, readRaw, restore, transcriptKey } from './transcript-r2.ts';

// A minimal on-disk-shaped JSONL: {type, message, ...} lines, one per record.
const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const convo = jsonl(
  { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
  { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
);

const withProjectsDir = async (fn: (projectsDir: string, nested: string) => Promise<void>): Promise<void> => {
  const root = join(tmpdir(), `Tmp_TranscriptR2_${process.pid}_${Math.random().toString(36).slice(2)}`);
  const nested = join(root, '-some-cwd-hash');
  try {
    mkdirSync(nested, { recursive: true });
    await fn(root, nested);
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
};

describe('transcriptKey', () => {
  test('T1 is a pure fn of sessionId', () => {
    expect(transcriptKey('sess-abc')).toBe('sessions/sess-abc/transcript.jsonl');
    expect(transcriptKey('sess-abc')).toBe(transcriptKey('sess-abc')); // deterministic
    expect(transcriptKey('other')).toBe('sessions/other/transcript.jsonl');
  });
});

describe('projectDirForCwd', () => {
  test('T2 encodes cwd → SDK project-dir segment (/ and . → -)', () => {
    expect(projectDirForCwd('/workspace/app')).toBe('-workspace-app');
    expect(projectDirForCwd('/home/u/.claude/x')).toBe('-home-u--claude-x');
  });
});

describe('backup → read round-trip', () => {
  test('T3 backup mirrors JSONL to R2; read projects it back', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const sessionId = 'sess-round';
      await Bun.write(join(nested, `${sessionId}.jsonl`), convo);
      const blob = memBackend();

      expect(await backup(blob, projectsDir, sessionId)).toBe(true);
      expect(await readRaw(blob, sessionId)).toBe(convo); // exact bytes preserved
      expect(await read(blob, sessionId)).toEqual([
        { kind: 'delta', text: 'hi', role: 'user' },
        { kind: 'delta', text: 'hello' },
      ]);
    });
  });

  test('T4 backup of an absent session writes nothing', async () => {
    await withProjectsDir(async (projectsDir) => {
      const blob = memBackend();
      expect(await backup(blob, projectsDir, 'nope')).toBe(false);
      expect(await readRaw(blob, 'nope')).toBeNull();
      expect(await read(blob, 'nope')).toEqual([]);
    });
  });
});

describe('restore', () => {
  test('T5 reconstructs the exact on-disk path the SDK resume needs', async () => {
    await withProjectsDir(async (projectsDir) => {
      const sessionId = 'sess-restore';
      const blob = memBackend();
      await blob.put(transcriptKey(sessionId), new TextEncoder().encode(convo));

      const cwd = '/workspace/app';
      const path = await restore(blob, projectsDir, cwd, sessionId);
      expect(path).toBe(join(projectsDir, '-workspace-app', `${sessionId}.jsonl`));
      expect(await Bun.file(path!).text()).toBe(convo);
    });
  });

  test('T6 restore with no R2 transcript is a no-op (null)', async () => {
    await withProjectsDir(async (projectsDir) => {
      expect(await restore(memBackend(), projectsDir, '/workspace/app', 'missing')).toBeNull();
    });
  });
});

describe('growing/partial transcript', () => {
  test('T7 re-backup overwrites; read returns the latest', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const sessionId = 'sess-grow';
      const file = join(nested, `${sessionId}.jsonl`);
      const blob = memBackend();

      // First backup: a single user line.
      await Bun.write(file, jsonl({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
      await backup(blob, projectsDir, sessionId);
      expect(await read(blob, sessionId)).toEqual([{ kind: 'delta', text: 'hi', role: 'user' }]);

      // Transcript grows on disk; re-backup overwrites with the fuller version.
      await Bun.write(file, convo);
      await backup(blob, projectsDir, sessionId);
      expect(await readRaw(blob, sessionId)).toBe(convo);
      expect(await read(blob, sessionId)).toEqual([
        { kind: 'delta', text: 'hi', role: 'user' },
        { kind: 'delta', text: 'hello' },
      ]);
    });
  });
});
