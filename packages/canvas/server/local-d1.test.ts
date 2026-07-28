import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDevDbUrl, localD1StateDir, localD1File } from './local-d1.ts';

const stateWithDatabases = (...files: string[]) => {
  const state = mkdtempSync(join(tmpdir(), 'cedarpad-d1-'));
  const dir = join(state, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), '');
  return { state, dir };
};

describe('localD1StateDir: isolation is the state dir, and it comes from env', () => {
  test('CANVAS_D1_STATE wins, so two worktrees never share one local D1', () => {
    const prev = process.env.CANVAS_D1_STATE;
    process.env.CANVAS_D1_STATE = '/somewhere/agent-abc/state';
    try {
      expect(localD1StateDir()).toBe('/somewhere/agent-abc/state');
    } finally {
      if (prev === undefined) delete process.env.CANVAS_D1_STATE;
      else process.env.CANVAS_D1_STATE = prev;
    }
  });

  test('unset falls back to the package’s canonical .wrangler/state', () => {
    const prev = process.env.CANVAS_D1_STATE;
    delete process.env.CANVAS_D1_STATE;
    try {
      expect(localD1StateDir()).toEndWith(join('packages', 'canvas', '.wrangler', 'state'));
    } finally {
      if (prev !== undefined) process.env.CANVAS_D1_STATE = prev;
    }
  });
});

describe('localDevDbUrl: the bridge opens the same local D1 the edge serves', () => {
  test('points at miniflare’s database file', () => {
    const { state, dir } = stateWithDatabases('metadata.sqlite', 'abc123.sqlite');
    expect(localDevDbUrl(state)).toBe(`file:${join(dir, 'abc123.sqlite')}`);
  });

  test('an unmigrated state dir names the command that fixes it', () => {
    const state = mkdtempSync(join(tmpdir(), 'cedarpad-d1-'));
    expect(() => localDevDbUrl(state)).toThrow(/webpoc:db:migrate:local/);
  });
});

describe('localD1File: the platform data layer that miniflare persisted for this worktree', () => {
  test('finds the database file, ignoring miniflare’s own metadata store', () => {
    const { state, dir } = stateWithDatabases('metadata.sqlite', 'abc123.sqlite');
    expect(localD1File(state)).toBe(join(dir, 'abc123.sqlite'));
  });

  test('a state dir with no applied migrations has no database yet', () => {
    const state = mkdtempSync(join(tmpdir(), 'cedarpad-d1-'));
    expect(localD1File(state)).toBeNull();
  });
});
