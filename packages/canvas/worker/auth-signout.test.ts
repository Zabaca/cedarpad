import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';

// Reproduces the reported bug ("signout doesn't work") end-to-end against the REAL edge
// Better Auth handler (`handleAuth`), exactly the way the browser drives it: sign in over
// HTTP, capture the session cookie, POST /api/auth/sign-out with that cookie AND an Origin
// header matching WEB_ORIGIN (Better Auth's CSRF check requires it — the Shell's own fetch
// is same-origin so the browser sends this automatically), then confirm `authenticate()`
// (the edge gate's session lookup) returns null afterward. In-memory DB built from the
// real migrations (mirrors inbox.test.ts / shell.test.ts).
const MIGRATIONS_DIR = fileURLToPath(new URL('../web-poc/lib/db/migrations', import.meta.url));
function migrationStatements(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .flatMap((f) =>
      readFileSync(`${MIGRATIONS_DIR}/${f}`, 'utf8')
        .split('--> statement-breakpoint')
        .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
        .filter(Boolean),
    );
}

const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
});

mock.module('../web-poc/worker/runtime.ts', () => ({ createDbForWorker: () => database }));

// NOTE: import `edgeAuth` (not the `authenticate` wrapper) for the "is this cookie still
// live" assertions below. `worker/index.test.ts` `mock.module`s `./auth-gate.ts` to stub
// `authenticate` and never restores it (a known bun `mock.module` leak across test files
// in the same process — see that file's own comment on it), so `authenticate` here would
// silently return its canned session regardless of the real cookie when the full suite runs.
const { edgeAuth, handleAuth } = await import('./auth-gate.ts');
const sessionFor = (cookie: string) => edgeAuth(env).api.getSession({ headers: new Headers({ cookie }) });

const ORIGIN = 'https://poc.cedarpad.com';
const env = {
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long!!',
  BETTER_AUTH_URL: ORIGIN,
  WEB_ORIGIN: ORIGIN,
} as unknown as import('./index.ts').Env;

function extractCookie(res: Response): string {
  // `Headers` collapses repeated `set-cookie` under Node/undici; Better Auth may set more
  // than one (session token + signed variant). getSetCookie() preserves each entry.
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('sign-out actually clears the edge session (repro for "signout doesn\'t work")', () => {
  test('sign up -> sign in -> sign out -> authenticate() sees no session', async () => {
    const signUp = await handleAuth(
      new Request(`${ORIGIN}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'jae@example.com', password: 'correct-horse-battery', name: 'Jae' }),
      }),
      env,
    );
    expect(signUp.status).toBe(200);
    const cookie = extractCookie(signUp);
    expect(cookie).not.toBe('');

    // The session is live: Better Auth resolves a user from the cookie.
    const beforeSignOut = await sessionFor(cookie);
    expect(beforeSignOut?.user).toBeTruthy();

    // Exactly what the Shell's `signOut()` does (Shell.tsx): a JSON POST — production
    // Better Auth 415s a body-less send with no content-type (the original bug), so the
    // client always sends `{}` with the header and this test mirrors that contract.
    const signOut = await handleAuth(
      new Request(`${ORIGIN}/api/auth/sign-out`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: '{}',
      }),
      env,
    );
    expect(signOut.status).toBe(200);

    // The cleared session must no longer authenticate — this is the actual "did sign-out
    // work" question a browser reload of `/` asks the edge gate.
    const afterSignOut = await sessionFor(cookie);
    expect(afterSignOut).toBeNull();
  });
});
