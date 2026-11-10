// Workspace skills as Records (ADR-0022, #361) — the container half.
//
// A Workspace skill (ADR-0013) is a directory under the package's `.claude/skills/`: a SKILL.md
// plus whatever supporting files it carries, discovered by the agent SDK's `project` setting
// source. Since the 2026-07-29 loss its truth is a ROW, not the file: `upload_skill` persists
// the Records first and writes the files second, and the tree on disk is a RENDERING.
//
// WHERE THIS DIFFERS FROM COMPONENTS, and why the slice is separate: nothing ever requests a
// skill file. A Component is materialized lazily because vite asks for the module and the client
// already handles a 404-then-retry; skill discovery is a FILESYSTEM SCAN the SDK performs while
// building the turn's options, and a file that is not there at that moment is a skill that does
// not exist for the turn. So skills are materialized eagerly, once per turn, BEFORE the turn
// starts (server/turn.ts) — the one point that is both after a possible recycle and before
// discovery.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import type { PlatformRpc } from './platform-rpc-client.ts';
import { loadWebPocEnv, platformRpcFromEnv } from './platform-rpc-env.ts';

// A chat turn's skills come from exactly two areas, each a local plugin the SDK is handed
// explicitly (server/agent.ts) — never from a setting source, so nothing leaks in from the
// process's home (~/.claude) or the repo's own developer .claude/skills:
//   platform-skills/   the `cedarpad` plugin: ours, code, reviewed by PR.
//   workspace-skills/  the `workspace` plugin: this workspace's Records, rendered below.
const PLATFORM_PLUGIN_DIR = fileURLToPath(new URL('../platform-skills', import.meta.url));
const WORKSPACE_PLUGIN_DIR = fileURLToPath(new URL('../workspace-skills', import.meta.url));

/** Where workspace skill Records render: the `workspace` plugin's skills dir. Trailing slash. */
export const SKILLS_DIR = `${WORKSPACE_PLUGIN_DIR}/skills/`;

const skillDirs = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];

/** A chat turn's skill options: both plugins, and an allowlist naming every skill in them —
 *  the allowlist is what keeps the SDK's own bundled skills out. Read at turn start, after
 *  materializeSkills, because discovery is a filesystem scan. */
export function chatSkillSources(): { plugins: Array<{ type: 'local'; path: string }>; skills: string[] } {
  return {
    plugins: [
      { type: 'local', path: PLATFORM_PLUGIN_DIR },
      { type: 'local', path: WORKSPACE_PLUGIN_DIR },
    ],
    skills: [
      ...skillDirs(`${PLATFORM_PLUGIN_DIR}/skills`).map((s) => `cedarpad:${s}`),
      ...skillDirs(SKILLS_DIR).map((s) => `workspace:${s}`),
    ],
  };
}

/** One file of one skill, as both the store and the tree on disk name it. */
export type SkillFile = { path: string; content: string };

/**
 * The container's door to the skill store: a skill named by its files, never a row and never a
 * query. Behind it is the platform RPC's `skill.write` / `skill.list` — the container holds no
 * database credential and never has.
 *
 * A default-parameter seam (the `components.ts` pattern), so the ordering rules below are
 * testable against a fake without a network or a D1.
 */
export interface SkillRecords {
  /** Persist a skill's files. THROWS when the store refuses or is unreachable. */
  write(skill: string, files: SkillFile[]): Promise<void>;
  /** The workspace's whole skill tree. THROWS on a store failure. */
  tree(): Promise<{ skill: string; path: string; content: string }[]>;
}

/**
 * The env-wired store, or **null when there is no edge in front of this process** — local dev
 * without the Worker, and the unit suite. An explicit state, not a fallback: with no store the
 * filesystem is all there is, exactly as it was before this ADR.
 */
const skillsDoor = (() => {
  const env = loadWebPocEnv();
  const rpc = platformRpcFromEnv(env);
  // 'default' is the legacy/prod workspace id (worker/shell-routing.ts DEFAULT_WORKSPACE_ID).
  return rpc ? { rpc, workspaceId: env.CANVAS_WORKSPACE || 'default' } : null;
})();

/** The skill store, attributing writes to `author` — who started the write, or null when that
 *  is unknown (the same rule as `componentRecordsOver`). `userId` is ATTRIBUTION — the edge
 *  decides permission itself. */
export function skillRecordsOver(rpc: PlatformRpc, workspaceId: string, author: string | null): SkillRecords {
  return {
    write: async (skill, files) => void (await rpc.skillWrite({ workspaceId, userId: author, skill, files })),
    tree: () => rpc.skillList({ workspaceId }),
  };
}

/** The env-wired skill store whose writes are attributed to `author`; null with no edge. */
export function skillRecordsFor(author: string | null): SkillRecords | null {
  return skillsDoor ? skillRecordsOver(skillsDoor.rpc, skillsDoor.workspaceId, author) : null;
}

/** The store materialization reads through. Null = no edge in front of this process. */
export const skillRecordStore = skillRecordsFor(null);

/** Where one skill file renders to, refusing anything that would land outside its skill dir.
 *  The contract's path rules (shared/skills-wire.ts) already rejected these; this is the last
 *  guard before a string becomes a filesystem location. */
function fileFor(skill: string, path: string): string {
  const dir = resolve(SKILLS_DIR, skill);
  const file = resolve(dir, path);
  if (!file.startsWith(`${dir}/`)) throw new Error(`invalid skill file path "${path}"`);
  return file;
}

/**
 * Create or overwrite a skill's files.
 *
 * ORDERING IS THE POINT (ADR-0022): the Records are persisted FIRST, and only then are the
 * files written. A store write that fails throws, so `upload_skill` fails and its caller can
 * retry; the alternative — the old one — was a disk write that reported success and evaporated
 * at the next bad boot.
 *
 * Files this upload does not mention are left alone, which is the merge behaviour the
 * files-only upload contract has always had (#177).
 */
export async function writeSkill(
  skill: string,
  files: SkillFile[],
  records: SkillRecords | null = skillRecordStore,
): Promise<void> {
  const targets = files.map((f) => ({ file: fileFor(skill, f.path), content: f.content }));
  await records?.write(skill, files);
  for (const t of targets) await Bun.write(t.file, t.content); // creates parent dirs
}

/**
 * Render the workspace's whole skill tree to disk.
 *
 * Eager and whole-tree, unlike a Component's on-demand single-module materialization, because
 * the SDK discovers skills by SCANNING `.claude/skills/` — there is no per-file request to hang
 * a lazy fetch off, and a file that is missing when discovery runs is simply not a skill.
 *
 * Best-effort by contract: a store failure costs this turn its WORKSPACE skills (platform
 * skills are image-baked and unaffected) and is logged, but it never fails the turn. The truth
 * is the rows and they are untouched — refusing to chat because a skill fetch blipped would be
 * a worse product than a turn that knows one fewer skill.
 */
export async function materializeSkills(records: SkillRecords | null = skillRecordStore): Promise<void> {
  if (!records) return;
  try {
    const tree = await records.tree();
    for (const f of tree) await Bun.write(fileFor(f.skill, f.path), f.content);
  } catch (err) {
    console.error('[skills] materialization failed; this turn sees platform skills only:', err);
  }
}
