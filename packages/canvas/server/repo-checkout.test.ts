import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkoutDirName, checkoutUrls, refreshCheckout, removeCheckout } from './repo-checkout.ts';

const run = async (cwd: string, args: string[]): Promise<string> => {
  const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')}: ${err}`);
  return out.trim();
};

async function scratchRemote(base: string): Promise<string> {
  const remote = join(base, 'remote');
  mkdirSync(remote, { recursive: true });
  await run(remote, ['init', '-b', 'main']);
  await run(remote, ['config', 'user.email', 't@t']);
  await run(remote, ['config', 'user.name', 't']);
  writeFileSync(join(remote, 'README.md'), 'v1\n');
  await run(remote, ['add', '.']);
  await run(remote, ['commit', '-m', 'v1']);
  return remote;
}

describe('checkout URLs — token embedded for the op, never persisted (ADR-0016)', () => {
  test('authed URL carries the token; the public URL (the at-rest origin) never does', () => {
    const { authed, publicUrl } = checkoutUrls('hudsonts/app', 'github_pat_x');
    expect(authed).toBe('https://x-access-token:github_pat_x@github.com/hudsonts/app.git');
    expect(publicUrl).toBe('https://github.com/hudsonts/app.git');
  });

  test('checkout dir name is filesystem-safe per repo', () => {
    expect(checkoutDirName('hudsonts/app')).toBe('hudsonts__app');
  });
});

describe('refreshCheckout — clone-or-update a read-only copy under .repos/', () => {
  test('first refresh clones; a later refresh follows upstream commits; remove deletes', async () => {
    const base = join(tmpdir(), `checkout-test-${crypto.randomUUID()}`);
    try {
      const remote = await scratchRemote(base);
      const root = join(base, 'workspace');
      mkdirSync(root, { recursive: true });

      const first = await refreshCheckout({ repo: 'hudsonts/app', root, remoteUrl: remote });
      expect(first.path).toBe(join(root, '.repos', 'hudsonts__app'));
      expect(await Bun.file(join(first.path, 'README.md')).text()).toBe('v1\n');

      // upstream moves; the checkout follows on the next refresh
      writeFileSync(join(remote, 'README.md'), 'v2\n');
      await run(remote, ['commit', '-am', 'v2']);
      const second = await refreshCheckout({ repo: 'hudsonts/app', root, remoteUrl: remote });
      expect(second.head).not.toBe(first.head);
      expect(await Bun.file(join(second.path, 'README.md')).text()).toBe('v2\n');

      // local drift (an agent poked the cache) is discarded — the checkout is a mirror
      writeFileSync(join(second.path, 'README.md'), 'tampered\n');
      const third = await refreshCheckout({ repo: 'hudsonts/app', root, remoteUrl: remote });
      expect(await Bun.file(join(third.path, 'README.md')).text()).toBe('v2\n');

      await removeCheckout(root, 'hudsonts/app');
      expect(await Bun.file(join(second.path, 'README.md')).exists()).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
