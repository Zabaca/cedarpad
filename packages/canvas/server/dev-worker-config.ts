// The edge Worker's LOCAL-DEV wrangler config (ADR-0018, #263), derived from the
// deployed `wrangler.jsonc` so the two can't drift. Generated, never committed: the
// production config stays free of the local D1 binding, so nothing here can reach a
// deploy.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_DEV_PLATFORM_SECRET } from '../shared/platform-rpc.ts';

/** Binding name for the platform data layer (root CONTEXT.md vocabulary). */
export const PLATFORM_DB_BINDING = 'PLATFORM_DB';

type Config = Record<string, unknown>;

/**
 * Parse JSONC (JSON + `//` and `/* *\/` comments) — what `wrangler.jsonc` is written in.
 *
 * Deliberately not `await import('…jsonc')`: Bun's loader handles that, but Playwright's
 * globalSetup runs this module through its own transform, which does not. A string scan
 * works under every runtime that loads this file.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out);
}

/**
 * `base` is the parsed `wrangler.jsonc`; `packageDir` is the absolute
 * `packages/canvas`. The generated config lives elsewhere (the state dir), so every
 * path it carries is made absolute.
 *
 * What local dev drops: `routes` (production custom domains), `triggers` (the daily
 * cron), `containers` (a docker image build the dev loop doesn't need — the container
 * is reached through the deployed worker, not this one), and `env` (named environments
 * are deploy targets).
 */
export function devWorkerConfig(base: Config, packageDir: string, origin: string): Config {
  const { routes, triggers, containers, env, ...rest } = base;
  const assets = base.assets as { directory: string } | undefined;
  const { AUTH_DISABLE_SIGNUP, ...vars } = (base.vars ?? {}) as Record<string, string>;
  return {
    ...rest,
    vars: {
      ...vars,
      // Better Auth is origin-sensitive: locally that origin is the vite dev server the
      // browser talks to, not the production domain baked into wrangler.jsonc.
      WEB_ORIGIN: origin,
      BETTER_AUTH_URL: origin,
      // Signup is open in dev (prod is James-only); scheduled work never runs locally.
      DEV_AGENT_ENABLED: 'false',
      // The platform RPC's trust root (ADR-0018 / #266): the container half of the dev stack
      // is the bun bridge, which derives its bearer from the same value. A real
      // `web-poc/.dev.vars` overrides this — wrangler gives `.dev.vars` precedence over
      // `vars` — so a configured worktree keeps its own secret and both ends still agree.
      BETTER_AUTH_SECRET: LOCAL_DEV_PLATFORM_SECRET,
    },
    main: join(packageDir, String(base.main)),
    ...(assets ? { assets: { ...assets, directory: join(packageDir, assets.directory) } } : {}),
    d1_databases: [
      ...((base.d1_databases as Config[] | undefined) ?? []),
      {
        binding: PLATFORM_DB_BINDING,
        database_name: 'cedarpad-platform',
        // Local only: miniflare keys its persisted database off this id, and no such
        // database exists in the account.
        database_id: 'local-dev',
        migrations_dir: join(packageDir, 'web-poc/lib/db/migrations'),
      },
    ],
  };
}

/** Absolute `packages/canvas` — every path in the generated config resolves against it. */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

/**
 * Write the generated config into the (per-worktree) miniflare state dir and return its
 * path, ready for `wrangler dev -c` / `wrangler d1 migrations apply -c`. It lives beside
 * the state it describes, so two worktrees never share one.
 */
export async function writeDevWorkerConfig(stateDir: string, origin: string): Promise<string> {
  // `wrangler.jsonc` stays the single source for both configs.
  const base = parseJsonc(readFileSync(join(PACKAGE_DIR, 'wrangler.jsonc'), 'utf8')) as Config;
  const config = devWorkerConfig(base, PACKAGE_DIR, origin);
  // The assets directory must exist for wrangler to boot, even before a `bun run build`.
  mkdirSync((config.assets as { directory: string }).directory, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, 'wrangler.dev.json');
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
