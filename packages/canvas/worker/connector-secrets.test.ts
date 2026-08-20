import { migrationStatements } from './migration-statements.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { addWorkspaceMember, createWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import { listWorkspaceConnectors } from '../web-poc/lib/db/queries/workspace-connectors.ts';
import { handleConnectorSecretsApi, resolveConnectorEnv } from './connector-secrets.ts';
import type { Env } from './index.ts';

// In-memory DB from the real migrations (mirrors github-connection.test.ts).
const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

const OWNER = { id: 'owner_cs1', email: 'owner_cs1@example.com' };
const MEMBER = { id: 'member_cs1', email: 'member_cs1@example.com' };

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  for (const u of [OWNER, MEMBER]) {
    await db.insert(schema.user).values({ id: u.id, name: u.id, email: u.email });
  }
});

const KEYED_ENV = { REPO_TOKEN_KEY: 'test-platform-key' } as unknown as Env;
const req = (method: string, body?: unknown) =>
  new Request('https://x/api/workspaces/w/connectors', { method, body: body ? JSON.stringify(body) : undefined });

async function freshWorkspace(name: string) {
  const ws = await createWorkspace(database, { name, ownerUserId: OWNER.id });
  await addWorkspaceMember(database, { workspaceId: ws.id, userId: MEMBER.id, role: 'member' });
  return ws;
}

describe('handleConnectorSecretsApi (#241) — owner-gated, list never leaks the secret', () => {
  test('the owner sets a connector secret; the workspace lists its name only, never plaintext or ciphertext', async () => {
    const ws = await freshWorkspace('connectors-lifecycle');
    const setRes = await handleConnectorSecretsApi(
      req('POST', { connectorName: 'slack', secret: 'xoxb-fake-token' }),
      KEYED_ENV,
      database,
      OWNER,
      ws.id,
    );
    expect(setRes.status).toBe(200);
    expect(await setRes.json()).toEqual({ connectorName: 'slack' });

    const listRes = await handleConnectorSecretsApi(req('GET'), KEYED_ENV, database, MEMBER, ws.id);
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { connectors: Array<Record<string, unknown>> };
    expect(body.connectors).toHaveLength(1);
    expect(body.connectors[0]?.connectorName).toBe('slack');
    // The list body must never contain the plaintext secret or the sealed ciphertext.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('xoxb-fake-token');
    const rows = await listWorkspaceConnectors(database, ws.id);
    expect(serialized).not.toContain(rows[0]!.encryptedSecret);
    expect(Object.keys(body.connectors[0] ?? {}).sort()).toEqual(['connectorName', 'createdAt']);
  });

  test('a member cannot set or delete a connector secret (403); a non-member gets 404', async () => {
    const ws = await freshWorkspace('connectors-owner-gate');
    const setByMember = await handleConnectorSecretsApi(
      req('POST', { connectorName: 'stripe', secret: 'sk_fake' }),
      KEYED_ENV,
      database,
      MEMBER,
      ws.id,
    );
    expect(setByMember.status).toBe(403);

    await handleConnectorSecretsApi(req('POST', { connectorName: 'stripe', secret: 'sk_fake' }), KEYED_ENV, database, OWNER, ws.id);
    const delByMember = await handleConnectorSecretsApi(req('DELETE', { connectorName: 'stripe' }), KEYED_ENV, database, MEMBER, ws.id);
    expect(delByMember.status).toBe(403);

    const notFound = await handleConnectorSecretsApi(req('GET'), KEYED_ENV, database, { id: 'stranger', email: 'x@x.com' }, ws.id);
    expect(notFound.status).toBe(404);
  });

  test('the owner rotates a secret by re-POSTing the same connector name; the sealed value changes', async () => {
    const ws = await freshWorkspace('connectors-rotate');
    await handleConnectorSecretsApi(req('POST', { connectorName: 'mercury', secret: 'first' }), KEYED_ENV, database, OWNER, ws.id);
    const [before] = await listWorkspaceConnectors(database, ws.id);
    await handleConnectorSecretsApi(req('POST', { connectorName: 'mercury', secret: 'second' }), KEYED_ENV, database, OWNER, ws.id);
    const [after] = await listWorkspaceConnectors(database, ws.id);
    expect(after?.encryptedSecret).not.toBe(before?.encryptedSecret);
    const rows = await listWorkspaceConnectors(database, ws.id);
    expect(rows).toHaveLength(1);
  });

  test('the owner deletes a connector; it disappears from the list', async () => {
    const ws = await freshWorkspace('connectors-delete');
    await handleConnectorSecretsApi(req('POST', { connectorName: 'slack', secret: 'xoxb-fake' }), KEYED_ENV, database, OWNER, ws.id);
    const delRes = await handleConnectorSecretsApi(req('DELETE', { connectorName: 'slack' }), KEYED_ENV, database, OWNER, ws.id);
    expect(delRes.status).toBe(204);
    expect(await listWorkspaceConnectors(database, ws.id)).toEqual([]);
  });

  test('without REPO_TOKEN_KEY, set is a 503 (nothing stored)', async () => {
    const ws = await freshWorkspace('connectors-no-key');
    const res = await handleConnectorSecretsApi(req('POST', { connectorName: 'slack', secret: 'x' }), {} as Env, database, OWNER, ws.id);
    expect(res.status).toBe(503);
    expect(await listWorkspaceConnectors(database, ws.id)).toEqual([]);
  });
});

describe('resolveConnectorEnv (#241) — the decrypted env the warehouse container reads', () => {
  test('decrypts every connector secret a workspace holds, keyed as CONNECTOR_<UPPERCASED NAME>', async () => {
    const ws = await freshWorkspace('connectors-resolve');
    await handleConnectorSecretsApi(req('POST', { connectorName: 'slack', secret: 'xoxb-fake' }), KEYED_ENV, database, OWNER, ws.id);
    await handleConnectorSecretsApi(req('POST', { connectorName: 'stripe', secret: 'sk_fake' }), KEYED_ENV, database, OWNER, ws.id);

    const env = await resolveConnectorEnv(KEYED_ENV, database, ws.id);
    expect(env).toEqual({ CONNECTOR_SLACK: 'xoxb-fake', CONNECTOR_STRIPE: 'sk_fake' });
  });

  test('an empty workspace resolves to an empty env; a missing key resolves to an empty env', async () => {
    const ws = await freshWorkspace('connectors-resolve-empty');
    expect(await resolveConnectorEnv(KEYED_ENV, database, ws.id)).toEqual({});

    await handleConnectorSecretsApi(req('POST', { connectorName: 'slack', secret: 'x' }), KEYED_ENV, database, OWNER, ws.id);
    expect(await resolveConnectorEnv({} as Env, database, ws.id)).toEqual({});
  });
});

// Blocking finding from PR review: a connector name becomes an environment-variable name
// in the warehouse container's process env (worker/container-env.ts). Without validation,
// an owner could set a connector literally named `R2_SECRET_ACCESS_KEY` (or `PATH`,
// `LD_PRELOAD`) — and because the R2 bucket is SHARED across every workspace
// (blob-store.ts: `workspaces/<ws>/…` inside one bucket, credentials are bucket- not
// prefix-scoped), code execution or credential replacement in the warehouse container is
// a cross-tenant escalation, not a self-inflicted mistake confined to the attacker's own
// workspace. This test is the boundary check: it must reject these names at the API layer
// BEFORE any encryption or storage happens.
describe('connector name validation (#241) — rejects env-var-injection-shaped names', () => {
  test.each(['PATH', 'R2_SECRET_ACCESS_KEY', 'LD_PRELOAD', 'CONNECTOR_SLACK', '', 'has spaces', '../etc/passwd'])(
    'rejects %p with a 400, storing nothing',
    async (badName) => {
      const ws = await freshWorkspace(`connectors-reject-${badName || 'empty'}`);
      const res = await handleConnectorSecretsApi(
        req('POST', { connectorName: badName, secret: 'attacker-controlled' }),
        KEYED_ENV,
        database,
        OWNER,
        ws.id,
      );
      expect(res.status).toBe(400);
      expect(await listWorkspaceConnectors(database, ws.id)).toEqual([]);
    },
  );

  test('a valid lowercase name is accepted', async () => {
    const ws = await freshWorkspace('connectors-accept-valid');
    const res = await handleConnectorSecretsApi(req('POST', { connectorName: 'slack', secret: 'x' }), KEYED_ENV, database, OWNER, ws.id);
    expect(res.status).toBe(200);
  });
});
