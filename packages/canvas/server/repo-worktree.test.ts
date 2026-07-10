import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  branchName,
  composePr,
  createRepoWorktreeManager,
  DEFAULT_REPO,
  GITHUB_TOKEN_ENV,
  sanitizeRefComponent,
  worktreeDirName,
} from './repo-worktree.ts';

// ── Pure: branch naming ──────────────────────────────────────────────────────────────

describe('branch naming — unique + valid git ref chars', () => {
  test('namespaced under dev-agent/ and composed from workflow + run', () => {
    expect(branchName('improve-arch', 'run42')).toBe('dev-agent/improve-arch-run42');
  });

  test('is unique per run — same workflow, different runs never collide', () => {
    expect(branchName('wf', 'a')).not.toBe(branchName('wf', 'b'));
  });

  test('sanitizes illegal git ref characters to a safe slug', () => {
    // spaces, `~^:?*`, `..`, uppercase, slashes → collapsed to single dashes, trimmed.
    const b = branchName('Feat: Improve Arch~2', 'run..*99');
    expect(b).toBe('dev-agent/feat-improve-arch-2-run-99');
    // no whitespace or the forbidden set survives.
    expect(b).not.toMatch(/[ ~^:?*[\\]/);
    expect(b).not.toContain('..');
  });

  test('empty / all-illegal ids fall back rather than producing an invalid ref', () => {
    expect(sanitizeRefComponent('***')).toBe('run');
    expect(sanitizeRefComponent('')).toBe('run');
  });

  test('worktree dir is derived from the branch leaf so parallel workflows differ', () => {
    expect(worktreeDirName(branchName('wf1', 'r'))).toBe('wf1-r');
    expect(worktreeDirName(branchName('wf1', 'r'))).not.toBe(
      worktreeDirName(branchName('wf2', 'r')),
    );
  });
});

// ── Pure: PR-body assembly ───────────────────────────────────────────────────────────

describe('PR assembly — title/body/base/head composed correctly', () => {
  test('base defaults to main; head is the branch', () => {
    const spec = composePr('dev-agent/wf-run', { title: 'T', body: 'B' });
    expect(spec).toEqual({ title: 'T', body: 'B', base: 'main', head: 'dev-agent/wf-run' });
  });

  test('explicit base is respected', () => {
    expect(composePr('br', { title: 'T', body: 'B', base: 'develop' }).base).toBe('develop');
  });

  test('default upstream repo is Zabaca/cedarpad', () => {
    expect(DEFAULT_REPO).toBe('Zabaca/cedarpad');
  });
});

// ── Integration: clone/commit against a LOCAL scratch repo (no network, no GitHub) ─────

const runGit = async (cwd: string, args: string[]) => {
  const p = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' },
  });
  const code = await p.exited;
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${await new Response(p.stderr).text()}`);
  return (await new Response(p.stdout).text()).trim();
};

describe('prepareWorktree/commit/cleanup against a local scratch remote', () => {
  test('clones, worktrees off origin/main, commits, and cleans up', async () => {
    const root = join(tmpdir(), `RepoWorktreeIT_${process.pid}_${Date.now()}`);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const workspace = join(root, 'ws');
    try {
      // Build a local "GitHub": a bare remote seeded with one commit on main.
      mkdirSync(root, { recursive: true });
      await runGit(root, ['init', '--bare', '-b', 'main', remote]);
      await runGit(root, ['clone', remote, seed]);
      await Bun.write(join(seed, 'README.md'), '# seed\n');
      await runGit(seed, ['add', '-A']);
      await runGit(seed, ['commit', '-m', 'seed']);
      await runGit(seed, ['push', 'origin', 'main']);

      const mgr = createRepoWorktreeManager({
        repo: 'Zabaca/cedarpad',
        workspaceRoot: workspace,
        remoteUrl: remote, // local path stands in for the GitHub URL
      });

      const branch = branchName('it-workflow', 'run1');
      const wt = await mgr.prepareWorktree(branch);
      expect(existsSync(wt.path)).toBe(true);
      expect(existsSync(join(wt.path, 'README.md'))).toBe(true); // off origin/main
      expect(await runGit(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);

      // A clean tree → nothing to commit.
      expect(await mgr.commit(wt, 'noop')).toBe(false);

      // Agent edits a file → commit succeeds.
      await Bun.write(join(wt.path, 'NEW.txt'), 'hello');
      expect(await mgr.commit(wt, 'feat: add NEW')).toBe(true);
      expect(await runGit(wt.path, ['log', '-1', '--pretty=%s'])).toBe('feat: add NEW');

      await mgr.cleanup(wt);
      expect(existsSync(wt.path)).toBe(false);
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Integration: ensureWorktree — the dev-agent turn's reuse-or-create (ADR-0010 slice 6) ─
//
// A dev-agent conversation spans turns: turn 2 must see turn 1's (uncommitted) edits, so an
// existing worktree for the branch is returned AS-IS — never reset to origin/main. And the
// turn's edits/commits land in the PREPARED worktree, never the caller's live tree (the
// baked image isn't even a git repo; committing CANVAS_CWD could never work).
describe('ensureWorktree — reuse-or-create for the multi-turn dev-agent grill flow', () => {
  test('creates when missing; a second call reuses the SAME tree, uncommitted edits intact', async () => {
    const root = join(tmpdir(), `EnsureWorktreeIT_${process.pid}_${Date.now()}`);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const workspace = join(root, 'ws');
    try {
      mkdirSync(root, { recursive: true });
      await runGit(root, ['init', '--bare', '-b', 'main', remote]);
      await runGit(root, ['clone', remote, seed]);
      await Bun.write(join(seed, 'README.md'), '# seed\n');
      await runGit(seed, ['add', '-A']);
      await runGit(seed, ['commit', '-m', 'seed']);
      await runGit(seed, ['push', 'origin', 'main']);

      const mgr = createRepoWorktreeManager({ repo: 'Zabaca/cedarpad', workspaceRoot: workspace, remoteUrl: remote });
      const branch = branchName('dev-agent', 'chat_1');

      // Turn 1: no worktree yet → created off origin/main.
      const wt1 = await mgr.ensureWorktree(branch);
      expect(existsSync(join(wt1.path, 'README.md'))).toBe(true);
      expect(await runGit(wt1.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(branch);

      // The agent edits during turn 1 (uncommitted — open_pr not called yet).
      await Bun.write(join(wt1.path, 'EDIT.txt'), 'turn-1 edit');

      // Turn 2: the SAME worktree comes back, edit intact — NOT a reset to origin/main.
      const wt2 = await mgr.ensureWorktree(branch);
      expect(wt2.path).toBe(wt1.path);
      expect(wt2.branch).toBe(branch);
      expect(await Bun.file(join(wt2.path, 'EDIT.txt')).text()).toBe('turn-1 edit');

      // The edits land in (and commit from) the prepared worktree, not the caller's cwd.
      expect(wt1.path.startsWith(workspace)).toBe(true);
      expect(await mgr.commit(wt2, 'feat: turn-1 edit')).toBe(true);
      expect(await runGit(wt2.path, ['log', '-1', '--pretty=%s'])).toBe('feat: turn-1 edit');
    } finally {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── Guard: real push+PR requires the token; unit suite must never hit GitHub ───────────

describe('pushAndOpenPR is gated on the GitHub token', () => {
  test('throws without DEV_AGENT_GITHUB_TOKEN instead of silently no-opping', async () => {
    const prev = process.env[GITHUB_TOKEN_ENV];
    delete process.env[GITHUB_TOKEN_ENV];
    try {
      const mgr = createRepoWorktreeManager({ repo: 'Zabaca/cedarpad', workspaceRoot: '/tmp/none' });
      await expect(
        mgr.pushAndOpenPR({ path: '/tmp/none', branch: 'b', hub: '/tmp/none' }, { title: 't', body: 'b' }),
      ).rejects.toThrow(GITHUB_TOKEN_ENV);
    } finally {
      if (prev !== undefined) process.env[GITHUB_TOKEN_ENV] = prev;
    }
  });
});

// ── The minted token reaches `gh` as GH_TOKEN (the container image lacks gh — see the
// Dockerfile — but the env threading is testable offline with a fake `gh` on PATH) ─────
//
// `pushAndOpenPR` pushes to a real (local scratch) remote, then spawns `gh pr create`. A
// fake `gh` script standing in for the real binary records the env it was invoked with, so
// this proves the token flows into the CHILD PROCESS's env only — never process.env itself.
describe('pushAndOpenPR threads the token to gh as GH_TOKEN on the spawned process only', () => {
  test('the fake gh sees GH_TOKEN; process.env is untouched', async () => {
    const root = join(tmpdir(), `PushPrIT_${process.pid}_${Date.now()}`);
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const workspace = join(root, 'ws');
    const fakeBin = join(root, 'bin');
    const captured = join(root, 'gh-invocation.json');
    const prevPath = process.env.PATH;
    try {
      mkdirSync(root, { recursive: true });
      mkdirSync(fakeBin, { recursive: true });
      await runGit(root, ['init', '--bare', '-b', 'main', remote]);
      await runGit(root, ['clone', remote, seed]);
      await Bun.write(join(seed, 'README.md'), '# seed\n');
      await runGit(seed, ['add', '-A']);
      await runGit(seed, ['commit', '-m', 'seed']);
      await runGit(seed, ['push', 'origin', 'main']);

      // A fake `gh` that just records argv + GH_TOKEN, then prints a fake PR URL — no
      // network, no real GitHub, so this runs fully offline.
      writeFileSync(
        join(fakeBin, 'gh'),
        `#!/bin/sh\ncat > "${captured}" <<EOF\n{"argv":"$*","ghToken":"$GH_TOKEN"}\nEOF\necho "https://github.com/fake/pr/1"\n`,
      );
      chmodSync(join(fakeBin, 'gh'), 0o755);

      const mgr = createRepoWorktreeManager({
        repo: 'Zabaca/cedarpad',
        workspaceRoot: workspace,
        remoteUrl: remote,
        token: 'sekrit-token',
      });
      const branch = branchName('gh-token-it', 'run1');
      const wt = await mgr.prepareWorktree(branch);
      await Bun.write(join(wt.path, 'NEW.txt'), 'hello');
      expect(await mgr.commit(wt, 'feat: add NEW')).toBe(true);

      // Put the fake gh first on PATH for this call only.
      process.env.PATH = `${fakeBin}:${prevPath}`;
      const url = await mgr.pushAndOpenPR(wt, { title: 'T', body: 'B' });

      expect(url).toBe('https://github.com/fake/pr/1');
      const invocation = JSON.parse(await Bun.file(captured).text());
      expect(invocation.ghToken).toBe('sekrit-token');
      expect(invocation.argv).toContain(branch);
      // The real assertion: pushAndOpenPR sets GH_TOKEN on the SPAWNED process's env only —
      // it never mutates process.env itself.
      expect(process.env[GITHUB_TOKEN_ENV]).not.toBe('sekrit-token');
    } finally {
      process.env.PATH = prevPath;
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    }
  });
});
