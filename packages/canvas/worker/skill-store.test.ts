import { describe, expect, test } from 'bun:test';

import { memSkillFileStore } from './skill-file-store.ts';
import { skillStore } from './skill-store.ts';

// The Workspace-skill policy layer: what a skill upload MEANS, independent of where the rows
// live. Driven against the in-memory port, so none of this needs a database.
//
// A skill is a DIRECTORY, not a file — SKILL.md plus whatever supporting paths it carries —
// which is why its key is two-level (the skill, then the path within it).

describe('SkillStore — a multi-file skill round-trips', () => {
  test('every file of an uploaded skill comes back in the workspace tree', async () => {
    const store = skillStore(memSkillFileStore());
    await store.write({
      workspaceId: 'ws_a',
      skill: 'corpus-linguist',
      userId: 'u_1',
      files: [
        { path: 'SKILL.md', content: '---\nname: corpus-linguist\n---\nbody' },
        { path: 'data/corpus.yaml', content: 'a: 1' },
      ],
    });

    expect(await store.tree('ws_a')).toEqual([
      { skill: 'corpus-linguist', path: 'SKILL.md', content: '---\nname: corpus-linguist\n---\nbody' },
      { skill: 'corpus-linguist', path: 'data/corpus.yaml', content: 'a: 1' },
    ]);
  });
});

describe('SkillStore — re-uploading a skill keeps the earlier content', () => {
  // The 2026-07-29 loss was a full replace with no history. A re-upload is the same shape:
  // without a version row, a bad SKILL.md is as final as a delete.
  test('the newest content wins, and the previous one is still retrievable', async () => {
    const files = memSkillFileStore();
    const store = skillStore(files);
    const upload = (content: string) =>
      store.write({ workspaceId: 'ws_a', skill: 'linter', userId: 'u_1', files: [{ path: 'SKILL.md', content }] });
    await upload('v1');
    await upload('v2');

    expect(await store.tree('ws_a')).toEqual([{ skill: 'linter', path: 'SKILL.md', content: 'v2' }]);
    const history = await files.listVersions({ workspaceId: 'ws_a', skill: 'linter', path: 'SKILL.md' });
    expect(history.map((v) => v.content)).toEqual(['v2', 'v1']);
    expect(history.map((v) => v.createdBy)).toEqual(['u_1', 'u_1']);
  });

  test('a re-upload leaves the skill files it did not mention alone', async () => {
    const store = skillStore(memSkillFileStore());
    await store.write({
      workspaceId: 'ws_a',
      skill: 'linter',
      userId: 'u_1',
      files: [
        { path: 'SKILL.md', content: 'v1' },
        { path: 'rules.md', content: 'keep me' },
      ],
    });
    await store.write({ workspaceId: 'ws_a', skill: 'linter', userId: 'u_1', files: [{ path: 'SKILL.md', content: 'v2' }] });

    expect(await store.tree('ws_a')).toEqual([
      { skill: 'linter', path: 'SKILL.md', content: 'v2' },
      { skill: 'linter', path: 'rules.md', content: 'keep me' },
    ]);
  });
});

describe('SkillStore — the edge validates, it does not trust the caller', () => {
  // A skill file path is the one field that becomes a filesystem location. Every rejected
  // shape here is a way "write a skill file" could have become "write somewhere else".
  test.each([['../outside.md'], ['/etc/absolute'], ['a/../../b'], ['dir\\file.md'], ['.hidden'], ['data/.env'], ['./SKILL.md'], ['a//b.md'], ['']])(
    'rejects the file path %p',
    async (path) => {
      const store = skillStore(memSkillFileStore());
      await expect(store.write({ workspaceId: 'ws_a', skill: 'ok', userId: null, files: [{ path, content: 'x' }] })).rejects.toThrow(
        /invalid skill file path/,
      );
    },
  );

  test.each([['../evil'], ['a/b'], ['.hidden'], ['']])('rejects the skill name %p', async (skill) => {
    const store = skillStore(memSkillFileStore());
    await expect(
      store.write({ workspaceId: 'ws_a', skill, userId: null, files: [{ path: 'SKILL.md', content: 'x' }] }),
    ).rejects.toThrow(/invalid skill name/);
  });

  test('a rejected upload stores NONE of its files, not just the offending one', async () => {
    const files = memSkillFileStore();
    const store = skillStore(files);
    await expect(
      store.write({
        workspaceId: 'ws_a',
        skill: 'ok',
        userId: null,
        files: [
          { path: 'SKILL.md', content: 'fine' },
          { path: '../escape.md', content: 'not fine' },
        ],
      }),
    ).rejects.toThrow();

    expect(await store.tree('ws_a')).toEqual([]);
  });
});
