import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';

import { SKILLS_DIR, type SkillRecords, materializeSkills, skillRecordStore, writeSkill } from './skills.ts';

// Workspace skills as Records (ADR-0022, #361). These drive the CONTAINER half — the ordering
// rule (store first, then disk) and the tree materialization a turn depends on — against a fake
// store, so none of it needs D1.
//
// Built from the failure: on 2026-07-29 every workspace skill was destroyed by a flush of an
// empty tree over the only copy. "The store accepted it" is now the thing being asserted, and
// the tree on disk is a rendering that a recycle is allowed to lose.

const SKILL = `zz-test-skill-${crypto.randomUUID().slice(0, 8)}`;
const dirOf = (skill: string) => `${SKILLS_DIR}${skill}`;

afterEach(() => {
  rmSync(dirOf(SKILL), { recursive: true, force: true });
});

// The unit suite must never reach a real edge. Run inside a bridge's process (an agent's Bash
// on the VM), it inherited PLATFORM_RPC_ORIGIN + BETTER_AUTH_SECRET, and bridge.test.ts's
// PUT /api/skills wrote 34 zz-test-skill Records into production's default workspace
// (2026-08-06 → 2026-09-09). `bun run test` blanks both; this pins that it did.
test('the unit suite has no platform RPC — nothing here can write a real workspace', () => {
  expect(skillRecordStore).toBeNull();
});

/** A store that remembers what it was told, and can be made to fail. */
function fakeRecords(opts: { failWrite?: boolean; failTree?: boolean } = {}) {
  const rows = new Map<string, string>();
  const calls: string[] = [];
  const records: SkillRecords = {
    write: async (skill, files) => {
      calls.push(`write ${skill} (${files.length})`);
      if (opts.failWrite) throw new Error('the workspace store refused this write');
      for (const f of files) rows.set(`${skill}/${f.path}`, f.content);
    },
    tree: async () => {
      calls.push('tree');
      if (opts.failTree) throw new Error('the workspace store is unreachable');
      return [...rows].map(([k, content]) => {
        const [skill, ...rest] = k.split('/');
        return { skill: skill as string, path: rest.join('/'), content };
      });
    },
  };
  return { records, rows, calls };
}

describe('upload_skill persists Records before it touches disk', () => {
  test('every file of a multi-file skill lands in the store and on disk', async () => {
    const { records, rows } = fakeRecords();
    await writeSkill(
      SKILL,
      [
        { path: 'SKILL.md', content: '---\nname: t\n---\nbody' },
        { path: 'data/corpus.yaml', content: 'a: 1' },
      ],
      records,
    );

    expect(rows.get(`${SKILL}/SKILL.md`)).toContain('body');
    expect(rows.get(`${SKILL}/data/corpus.yaml`)).toBe('a: 1');
    expect(readFileSync(`${dirOf(SKILL)}/SKILL.md`, 'utf8')).toContain('body');
    expect(readFileSync(`${dirOf(SKILL)}/data/corpus.yaml`, 'utf8')).toBe('a: 1');
  });

  test('a store write failure FAILS the upload and leaves no file behind', async () => {
    const { records } = fakeRecords({ failWrite: true });

    await expect(writeSkill(SKILL, [{ path: 'SKILL.md', content: 'x' }], records)).rejects.toThrow(/refused this write/);
    expect(existsSync(dirOf(SKILL))).toBe(false);
  });
});

describe('a skill survives the container losing its filesystem', () => {
  test('materialization renders the whole tree, so the SDK can discover it by scanning', async () => {
    const { records } = fakeRecords();
    await writeSkill(
      SKILL,
      [
        { path: 'SKILL.md', content: 'v1' },
        { path: 'data/corpus.yaml', content: 'a: 1' },
      ],
      records,
    );

    // The recycle: the container comes back with an empty tree. There is no boot restore.
    rmSync(dirOf(SKILL), { recursive: true, force: true });
    expect(existsSync(dirOf(SKILL))).toBe(false);

    await materializeSkills(records);

    expect(readFileSync(`${dirOf(SKILL)}/SKILL.md`, 'utf8')).toBe('v1');
    expect(readFileSync(`${dirOf(SKILL)}/data/corpus.yaml`, 'utf8')).toBe('a: 1');
  });

  test('a workspace with no skills materializes nothing and does not fail', async () => {
    const { records, calls } = fakeRecords();
    await materializeSkills(records);
    expect(calls).toEqual(['tree']);
  });

  test('an unreachable store does not fail the turn — it costs the workspace skills, not the chat', async () => {
    const { records } = fakeRecords({ failTree: true });
    await materializeSkills(records);
  });
});

describe('with no edge in front of the container, the filesystem is all there is', () => {
  // Local dev without the edge Worker, and the unit suite: an explicit state, not a fallback.
  test('the upload still writes its files, and materializing is a no-op', async () => {
    await writeSkill(SKILL, [{ path: 'SKILL.md', content: 'local' }], null);
    await materializeSkills(null);

    expect(readFileSync(`${dirOf(SKILL)}/SKILL.md`, 'utf8')).toBe('local');
  });
});
