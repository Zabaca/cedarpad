// Workspace-skill policy over the skill-file port (ADR-0022). What a skill upload MEANS — the
// name rule, the path rules — lives here, above `SkillFileStore` and below the transport. It
// holds no SQL and no HTTP, so its rules are testable against the in-memory port with no
// database.
//
// This runs at the EDGE, deliberately: ADR-0022 says validation and ownership are enforced on
// the side that owns the rows, never trusted from the container's payload.

import { SkillFilePath, SkillName } from '../shared/skills-wire.ts';
import type { SkillFileStore } from './skill-file-store.ts';

/** One plain directory name under `.claude/skills/`. */
export function assertSkillName(skill: string): void {
  if (!SkillName.safeParse(skill).success) {
    throw new Error(`invalid skill name "${skill}" — one plain directory name, no path separators`);
  }
}

/** A path INSIDE that directory. This string becomes a filesystem location, so a traversing
 *  or absolute one is how "write a skill file" becomes "write somewhere else". */
export function assertSkillFilePath(path: string): void {
  if (!SkillFilePath.safeParse(path).success) {
    throw new Error(`invalid skill file path "${path}" — relative and normalized, no .. segments and no dotfiles`);
  }
}

/** One file of one skill, as the container renders it: `.claude/skills/<skill>/<path>`. */
export type SkillTreeFile = { skill: string; path: string; content: string };

export interface SkillStore {
  /** Persist a skill's files. Throws on an invalid skill name or file path. */
  write(input: { workspaceId: string; skill: string; userId: string | null; files: { path: string; content: string }[] }): Promise<{ files: number }>;
  /** The workspace's WHOLE skill tree — what materialization renders before a turn. */
  tree(workspaceId: string): Promise<SkillTreeFile[]>;
}

export function skillStore(files: SkillFileStore): SkillStore {
  return {
    write: async ({ workspaceId, skill, userId, files: uploaded }) => {
      // Validate the WHOLE upload before storing any of it: a half-applied skill is a skill
      // whose SKILL.md promises files that are not there.
      assertSkillName(skill);
      for (const f of uploaded) assertSkillFilePath(f.path);
      for (const f of uploaded) {
        await files.put({ workspaceId, skill, path: f.path, content: f.content, updatedBy: userId });
      }
      return { files: uploaded.length };
    },
    tree: async (workspaceId) =>
      (await files.list(workspaceId)).map((r) => ({ skill: r.skill, path: r.path, content: r.content })),
  };
}
