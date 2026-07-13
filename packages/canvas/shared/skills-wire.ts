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

/** A file inside the skill dir: relative, normalized, no traversal, no absolute paths. */
export const SkillFilePath = z
  .string()
  .min(1)
  .max(200)
  .refine((p) => !p.startsWith('/') && !p.includes('..') && !p.includes('\\'), {
    message: 'file paths must be relative, without .. segments',
  });

export const UploadSkillInput = z.object({
  files: z
    .array(z.object({ path: SkillFilePath, content: z.string().max(512 * 1024) }))
    .min(1)
    .max(64),
});
export type UploadSkillInput = z.infer<typeof UploadSkillInput>;
