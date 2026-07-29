import { z } from 'zod';

// Single contract (CLAUDE.md §7) for the workspace-skill upload boundary (#177):
// the edge MCP tool `upload_skill` encodes this body; the bridge's
// `PUT /api/skills/:name` parses it. A skill is CONTENT (ADR-0013): text the model
// reads — the worst a malicious upload can do is ask, so the shape is files-only,
// with the path rules enforced again server-side.

/** Skill dir name: one path segment, no traversal, no dotfiles. */
export const SkillName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, 'skill name must be a plain directory name');

/** One segment of a skill file path. A leading dot is excluded, which is what rules out `.`,
 *  `..` and dotfiles in one stroke; the closed character class is what rules out backslashes,
 *  and requiring every segment to match is what rules out `/abs`, `a//b` and trailing slashes. */
const SKILL_PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** A file inside the skill dir: relative, normalized, no traversal, no dotfiles, no absolute
 *  paths. Enforced HERE — in the contract both ends parse — and again by the skill store at
 *  the edge, because this string becomes a filesystem location in the container. */
export const SkillFilePath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => p.split('/').every((seg) => SKILL_PATH_SEGMENT.test(seg)), {
    message: 'file paths must be relative and normalized: no leading /, no . or .. segments, no dotfiles',
  });

export const UploadSkillInput = z.object({
  files: z
    .array(z.object({ path: SkillFilePath, content: z.string().max(512 * 1024) }))
    .min(1)
    .max(64),
});
export type UploadSkillInput = z.infer<typeof UploadSkillInput>;
