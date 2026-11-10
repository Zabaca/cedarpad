import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findSessionJsonl, resumeJsonlPath } from './session-jsonl.ts';

const withProjectsDir = async (fn: (projectsDir: string) => Promise<void>): Promise<void> => {
  const root = join(tmpdir(), `Tmp_SessionJsonl_${process.pid}_${Math.random().toString(36).slice(2)}`);
  try {
    mkdirSync(root, { recursive: true });
    await fn(root);
  } finally {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
};

describe('resumeJsonlPath — the exact path the SDK resume reads', () => {
  test('composes projectsDir / encoded-cwd / <sessionId>.jsonl', () => {
    expect(resumeJsonlPath('/root/.claude/projects', '/workspace/app', 'sess-1')).toBe(
      join('/root/.claude/projects', '-workspace-app', 'sess-1.jsonl'),
    );
  });
});

describe('findSessionJsonl — nesting-robust lookup', () => {
  test('locates the JSONL whether nested under a cwd-hash dir or flat at the root', async () => {
    await withProjectsDir(async (projectsDir) => {
      const nested = join(projectsDir, '-workspace-app', 'sess-a.jsonl');
      await Bun.write(nested, 'x\n');
      expect(await findSessionJsonl(projectsDir, 'sess-a')).toEqual([nested]);

      const flat = join(projectsDir, 'sess-b.jsonl');
      await Bun.write(flat, 'y\n');
      expect(await findSessionJsonl(projectsDir, 'sess-b')).toEqual([flat]);
    });
  });

  test('returns [] when the session has no JSONL under projectsDir', async () => {
    await withProjectsDir(async (projectsDir) => {
      expect(await findSessionJsonl(projectsDir, 'nope')).toEqual([]);
    });
  });
});
