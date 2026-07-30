import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { memBackend } from './blob-store.ts';
import {
  adoptSession,
  backup,
  projectDirForCwd,
  read,
  readRaw,
  restore,
  TranscriptStore,
  transcriptKey,
} from './transcript-store.ts';

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

  test('T2b every non-alphanumeric maps to - (the SDK sanitizes _ too — the per-repo worktree root Zabaca__cedarpad)', () => {
    // Verified empirically against the CLI: cwd `.../under_score_test` → project dir `...-under-score-test`.
    expect(projectDirForCwd('/app/x/.dev-agent/Zabaca__cedarpad/worktrees/run-1')).toBe(
      '-app-x--dev-agent-Zabaca--cedarpad-worktrees-run-1',
    );
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

  // The warehouse (ADR-0017 mart_session_events) used to read the whole sessions.tar; with one
  // object per session its source is this listing.
  test('listSessions names every stored session, and nothing else in the bucket', async () => {
    const blobs = memBackend();
    await blobs.put(transcriptKey('sess-a'), new TextEncoder().encode(convo));
    await blobs.put(transcriptKey('sess-b'), new TextEncoder().encode(convo));
    await blobs.put('workspaces/ws-1/warehouse/mart_session_events.parquet', new Uint8Array([1]));

    expect((await new TranscriptStore(blobs, '/nowhere').listSessions()).sort()).toEqual(['sess-a', 'sess-b']);
  });

  test('an empty bucket lists no sessions rather than failing', async () => {
    expect(await new TranscriptStore(memBackend(), '/nowhere').listSessions()).toEqual([]);
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
