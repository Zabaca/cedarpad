// The one git subprocess runner for the server's repo modules (repo-checkout.ts, repo-worktree.ts):
// spawn `git <args>` in `cwd`, return trimmed stdout, throw with stderr on a non-zero exit.
// `env` merges over the process env (e.g. a push's token var); absent ⇒ the process env as-is.
export const git = async (cwd: string, args: string[], env?: Record<string, string>): Promise<string> => {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: env ? { ...process.env, ...env } : process.env,
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed (${code}): ${err.trim()}`);
  return out.trim();
};
