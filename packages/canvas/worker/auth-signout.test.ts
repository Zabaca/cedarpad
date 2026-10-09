import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { eq } from 'drizzle-orm';
import * as schema from '../web-poc/lib/db/schema.ts';

// Reproduces the reported bug ("signout doesn't work") end-to-end against the REAL edge
// Better Auth handler (`handleAuth`), exactly the way the browser drives it: sign in over
// HTTP, capture the session cookie, POST /api/auth/sign-out with that cookie AND an Origin
// header matching WEB_ORIGIN (Better Auth's CSRF check requires it — the Shell's own fetch
// is same-origin so the browser sends this automatically), then confirm `authenticate()`
// (the edge gate's session lookup) returns null afterward. In-memory DB built from the
// real migrations (mirrors shell.test.ts).
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

// Captures what the send seam would have put on the wire. Passwordless means the ONLY
// way to mint a session is to verify an emailed link, so the test has to read the mail.
const outbox: Array<{ to: string; subject: string; text?: string }> = [];
const env = {
  BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long!!',
  BETTER_AUTH_URL: ORIGIN,
  WEB_ORIGIN: ORIGIN,
  EMAIL: {
    send: async (msg: { to: string; subject: string; text?: string }) => {
      outbox.push(msg);
    },
  },
} as unknown as import('./index.ts').Env;

/** Drive a full passwordless sign-in and return the session cookie it mints. */
async function signInByMagicLink(email: string): Promise<string> {
  outbox.length = 0;
  const requested = await handleAuth(
    new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, callbackURL: '/' }),
    }),
    env,
  );
  expect(requested.status).toBe(200);

  // The link only exists in the email — exactly the property that makes an uninvited
  // address unable to sign itself in.
  expect(outbox).toHaveLength(1);
  const token = /token=([A-Za-z0-9_.-]+)/.exec(outbox[0]?.text ?? '')?.[1];
  expect(token).toBeTruthy();

  const verified = await handleAuth(
    new Request(`${ORIGIN}/api/auth/magic-link/verify?token=${token}&callbackURL=/`, {
      headers: { origin: ORIGIN },
    }),
    env,
  );
  const cookie = extractCookie(verified);
  expect(cookie).not.toBe('');
  return cookie;
}

function extractCookie(res: Response): string {
  // `Headers` collapses repeated `set-cookie` under Node/undici; Better Auth may set more
  // than one (session token + signed variant). getSetCookie() preserves each entry.
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

describe('sign-out actually clears the edge session (repro for "signout doesn\'t work")', () => {
  test('magic-link sign in -> sign out -> authenticate() sees no session', async () => {
    // An existing account is one half of the magic-link allowlist (a pending invitation
    // is the other), so seeding the row is what makes this address eligible for a link.
    await db.insert(schema.user).values({ id: 'jae_1', name: 'Jae', email: 'jae@example.com' });
    const cookie = await signInByMagicLink('jae@example.com');

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

// The passwordless cutover moved the signup gate into `sendMagicLink`. Better Auth's
// sign-in/magic-link endpoint is PUBLIC and creates a user on verify, so if a link went
// out to any address that asked, cedarpad would have open signup.
describe('magic-link allowlist — the door that replaced AUTH_DISABLE_SIGNUP', () => {
  test('an uninvited address gets no link, and the response is indistinguishable from an invited one', async () => {
    outbox.length = 0;
    const res = await handleAuth(
      new Request(`${ORIGIN}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: 'stranger@example.com', callbackURL: '/' }),
      }),
      env,
    );

    // Same 200 an invited address gets — the endpoint must not confirm who has access.
    expect(res.status).toBe(200);
    // ...but nothing was actually sent, so the stranger can never complete a sign-in.
    expect(outbox).toEqual([]);
    // And no account was conjured by merely asking.
    const rows = await db.select().from(schema.user).where(eq(schema.user.email, 'stranger@example.com'));
    expect(rows).toHaveLength(0);
  });
});
