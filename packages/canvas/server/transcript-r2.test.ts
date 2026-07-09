import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memBackend } from './blob-store.ts';
import { adoptSession, backup, projectDirForCwd, read, readRaw, restore, transcriptKey } from './transcript-r2.ts';

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

// ADR-0010 slice 6: a dev-agent turn runs under its prepared worktree's cwd, but the batch
// explore session's JSONL was written under CANVAS_CWD (and a cold-boot restore re-lands it
// there) — the SDK's resume is cwd-scoped (#133), so the JSONL must MOVE (not copy: the
// transcript loader concatenates every glob match, so a duplicate doubles history) into the
// worktree's project dir before the turn.
describe('adoptSession — move a session JSONL to the project dir of a new cwd', () => {
  test('moves the JSONL from another project dir to exactly where resume(cwd) reads', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const sessionId = 'sess-adopt';
      await Bun.write(join(nested, `${sessionId}.jsonl`), convo);

      const cwd = '/workspace/wt';
      const dest = await adoptSession(projectsDir, sessionId, cwd);

      expect(dest).toBe(join(projectsDir, '-workspace-wt', `${sessionId}.jsonl`));
      expect(await Bun.file(dest!).text()).toBe(convo);
      expect(existsSync(join(nested, `${sessionId}.jsonl`))).toBe(false); // moved, not copied
    });
  });

  test('idempotent: already home ⇒ untouched; a stale duplicate elsewhere is removed (dest wins)', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const sessionId = 'sess-home';
      const cwd = '/workspace/wt';
      const dest = join(projectsDir, projectDirForCwd(cwd), `${sessionId}.jsonl`);
      const grown = convo + jsonl({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } });
      await Bun.write(dest, grown); // the SDK has been appending here (authoritative)
      await Bun.write(join(nested, `${sessionId}.jsonl`), convo); // a stale restore artifact

      expect(await adoptSession(projectsDir, sessionId, cwd)).toBe(dest);
      expect(await Bun.file(dest).text()).toBe(grown); // dest NOT clobbered by the stale copy
      expect(existsSync(join(nested, `${sessionId}.jsonl`))).toBe(false); // duplicate culled
    });
  });

  test('absent session ⇒ null (a fresh session has no JSONL to adopt)', async () => {
    await withProjectsDir(async (projectsDir) => {
      expect(await adoptSession(projectsDir, 'nope', '/workspace/wt')).toBeNull();
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
