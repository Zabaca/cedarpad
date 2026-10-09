import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memBackend } from './blob-store.ts';
import {
  backup,
  projectDirForCwd,
  restore,
  TranscriptStore,
  transcriptKey,
} from './transcript-store.ts';

// A minimal on-disk-shaped JSONL: {type, message, ...} lines, one per record.
const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
/** What R2 holds for a session, decoded — null when absent. */
const stored = async (blob: ReturnType<typeof memBackend>, sessionId: string): Promise<string | null> => {
  const bytes = await blob.get(transcriptKey(sessionId));
  return bytes === null ? null : new TextDecoder().decode(bytes);
};

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

  test('T2b every non-alphanumeric maps to - (the SDK sanitizes _ too — the per-repo worktree root Zabaca__cedarpad)', () => {
    // Verified empirically against the CLI: cwd `.../under_score_test` → project dir `...-under-score-test`.
    expect(projectDirForCwd('/app/x/.dev-agent/Zabaca__cedarpad/worktrees/run-1')).toBe(
      '-app-x--dev-agent-Zabaca--cedarpad-worktrees-run-1',
    );
  });
});

describe('backup → R2', () => {
  test('T3 backup mirrors the JSONL to R2 byte for byte', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const sessionId = 'sess-round';
      await Bun.write(join(nested, `${sessionId}.jsonl`), convo);
      const blob = memBackend();

      expect(await backup(blob, projectsDir, sessionId)).toBe(true);
      expect(await stored(blob, sessionId)).toBe(convo); // exact bytes preserved
    });
  });

  test('T4 backup of an absent session writes nothing', async () => {
    await withProjectsDir(async (projectsDir) => {
      const blob = memBackend();
      expect(await backup(blob, projectsDir, 'nope')).toBe(false);
      expect(await stored(blob, 'nope')).toBeNull();
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

// #356: a Transcript is a FILE (CONTEXT.md → Record vs File) — one opaque object per session.
// These tests pin the granularity rule the slice exists for: a turn writes the ONE session it
// touched, and a resume fetches the ONE session it needs. The old `sessions.tar` sink wrote the
// whole workspace's history on every turn (49 MB measured in production, against ~650 KB of
// appends) and boot downloaded all of it back.
describe('TranscriptStore', () => {
  test('a session round-trips put → get with its bytes verbatim', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const store = new TranscriptStore(memBackend(), projectsDir);
      await Bun.write(join(nested, 'sess-a.jsonl'), convo);

      expect(await store.put('sess-a')).toBe(true);
      // Opaque custody: the SDK owns this format, so the bytes must come back unchanged.
      expect(new TextDecoder().decode((await store.get('sess-a'))!)).toBe(convo);
    });
  });

  test('a turn writes ONLY the session it touched — every other session is untouched', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const blobs = memBackend();
      const store = new TranscriptStore(blobs, projectsDir);
      // Two sessions live on disk, as they do in a workspace with history.
      await Bun.write(join(nested, 'sess-old.jsonl'), convo);
      await Bun.write(join(nested, 'sess-live.jsonl'), convo);
      await store.put('sess-old');
      const writes: string[] = [];
      const counting = { ...blobs, put: async (k: string, d: Uint8Array) => void (writes.push(k), await blobs.put(k, d)) };

      // The turn touched sess-live and grew its JSONL; only that object may be written.
      await Bun.write(join(nested, 'sess-live.jsonl'), convo + convo);
      await new TranscriptStore(counting, projectsDir).put('sess-live');

      expect(writes).toEqual([transcriptKey('sess-live')]);
    });
  });

  test('a session with no JSONL on disk writes nothing — an absent read never becomes a destructive write', async () => {
    await withProjectsDir(async (projectsDir) => {
      const blobs = memBackend();
      await blobs.put(transcriptKey('sess-gone'), new TextEncoder().encode(convo));
      const store = new TranscriptStore(blobs, projectsDir);

      expect(await store.put('sess-gone')).toBe(false);
      // The stored transcript survives: nothing was overwritten with emptiness.
      expect(new TextDecoder().decode((await store.get('sess-gone'))!)).toBe(convo);
    });
  });

  test('resuming after a recycle materializes that ONE session at the path the SDK reads', async () => {
    await withProjectsDir(async (projectsDir) => {
      const blobs = memBackend();
      await blobs.put(transcriptKey('sess-mine'), new TextEncoder().encode(convo));
      await blobs.put(transcriptKey('sess-theirs'), new TextEncoder().encode(convo));
      const reads: string[] = [];
      const counting = { ...blobs, get: async (k: string) => (reads.push(k), await blobs.get(k)) };

      const cwd = '/workspace/app';
      const path = await new TranscriptStore(counting, projectsDir).materialize('sess-mine', cwd);

      expect(path).toBe(join(projectsDir, projectDirForCwd(cwd), 'sess-mine.jsonl'));
      expect(await Bun.file(path!).text()).toBe(convo);
      // Only the resumed session was fetched — the rest of the workspace's history stayed in R2.
      expect(reads).toEqual([transcriptKey('sess-mine')]);
    });
  });

  test('a warm container keeps its live JSONL — materialize never clobbers it with a stale object', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const blobs = memBackend();
      await blobs.put(transcriptKey('sess-live'), new TextEncoder().encode('STALE\n'));
      // The SDK has been appending here since the last backup; disk is authoritative.
      const live = join(nested, 'sess-live.jsonl');
      await Bun.write(live, convo);

      expect(await new TranscriptStore(blobs, projectsDir).materialize('sess-live', '/workspace/app')).toBe(live);
      expect(await Bun.file(live).text()).toBe(convo);
      // ...and no second copy: the transcript loader concatenates every match, so a duplicate
      // would double the history the agent resumes from.
      expect(existsSync(join(projectsDir, projectDirForCwd('/workspace/app'), 'sess-live.jsonl'))).toBe(false);
    });
  });

  test('a fresh session that is nowhere yields null rather than throwing on a cold projects dir', async () => {
    const store = new TranscriptStore(memBackend(), join(tmpdir(), `Tmp_ColdBoot_${process.pid}_never_created`));
    expect(await store.materialize('sess-new', '/workspace/app')).toBeNull();
  });

  // FAIL-OPEN MUST NOT RETURN (#366). With the tarball sinks retired this is the ONLY restore
  // path left in the container, and it is the one place the 2026-07-29 root cause could grow
  // back: a read that failed, was swallowed, and became the new truth. "Nowhere" (the test
  // above) and "the read failed" are different answers and must stay different — a storage
  // failure has to reach the turn, which fails visibly, rather than resuming a conversation
  // with no history and calling that a fresh session.
  test('a storage failure while materializing THROWS — a failed read never passes as an empty history', async () => {
    await withProjectsDir(async (projectsDir) => {
      const blobs = { ...memBackend(), get: async () => { throw new Error('R2 unreachable'); } };
      const store = new TranscriptStore(blobs, projectsDir);

      expect(store.materialize('sess-mine', '/workspace/app')).rejects.toThrow('R2 unreachable');
    });
  });
});

describe('growing/partial transcript', () => {
  test('T7 re-backup overwrites with the latest', async () => {
    await withProjectsDir(async (projectsDir, nested) => {
      const sessionId = 'sess-grow';
      const file = join(nested, `${sessionId}.jsonl`);
      const blob = memBackend();

      // First backup: a single user line.
      await Bun.write(file, jsonl({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }));
      await backup(blob, projectsDir, sessionId);
      const first = await stored(blob, sessionId);

      // Transcript grows on disk; re-backup overwrites with the fuller version.
      await Bun.write(file, convo);
      await backup(blob, projectsDir, sessionId);
      expect(await stored(blob, sessionId)).toBe(convo);
      expect(first).not.toBe(convo);
    });
  });
});
