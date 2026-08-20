import { migrationStatements } from './migration-statements.ts';
import { beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from '../web-poc/lib/db/schema.ts';
import { createWorkspace, getWorkspaceRecord, setWorkspaceSelectedRepos } from '../web-poc/lib/db/queries/workspaces.ts';
import {
  addPatRepo,
  addPublicRepo,
  clearInstallationRepos,
  listWorkspaceRepos,
  removeAddedRepo,
  replaceInstallationRepos,
  updatePatRepoToken,
} from '../web-poc/lib/db/queries/workspace-repos.ts';

// In-memory DB from the real migrations (mirrors github-connection.test.ts).
const client = createClient({ url: ':memory:' });
const db = drizzle(client, { schema });
const database = db as never;

const OWNER = { id: 'owner_wr1', email: 'owner_wr1@example.com' };

beforeAll(async () => {
  for (const stmt of migrationStatements()) await client.execute(stmt);
  await db.insert(schema.user).values({ id: OWNER.id, name: OWNER.id, email: OWNER.email });
});

async function freshWorkspace(name: string) {
  return await createWorkspace(database, { name, ownerUserId: OWNER.id });
}

describe('workspace repos (ADR-0016) — one row per Repo asset', () => {
  test('a PAT repo is added, listed, rotated, and removed', async () => {
    const ws = await freshWorkspace('pat-lifecycle');
    await addPatRepo(database, {
      workspaceId: ws.id,
      fullName: 'hudsonts/app',
      encryptedToken: 'v1.iv.ct',
      addedByUserId: OWNER.id,
    });
    let repos = await listWorkspaceRepos(database, ws.id);
    expect(repos.map((r) => r.fullName)).toEqual(['hudsonts/app']);
    expect(repos[0]?.source).toBe('pat');
    expect(repos[0]?.encryptedToken).toBe('v1.iv.ct');

    await updatePatRepoToken(database, { workspaceId: ws.id, fullName: 'hudsonts/app', encryptedToken: 'v1.iv2.ct2' });
    repos = await listWorkspaceRepos(database, ws.id);
    expect(repos[0]?.encryptedToken).toBe('v1.iv2.ct2');

    await removeAddedRepo(database, { workspaceId: ws.id, fullName: 'hudsonts/app' });
    expect(await listWorkspaceRepos(database, ws.id)).toEqual([]);
  });

  test('a public repo is added token-less, listed, and removed; installation rows are safe from removeAddedRepo', async () => {
    const ws = await freshWorkspace('public-lifecycle');
    await addPublicRepo(database, { workspaceId: ws.id, fullName: 'vercel/next.js', addedByUserId: OWNER.id });
    await replaceInstallationRepos(database, { workspaceId: ws.id, repos: ['Zabaca/cedarpad'] });

    let repos = await listWorkspaceRepos(database, ws.id);
    const pub = repos.find((r) => r.fullName === 'vercel/next.js');
    expect(pub?.source).toBe('public');
    expect(pub?.encryptedToken).toBeNull();

    // removeAddedRepo only touches user-added rows (pat/public), never the installation selection.
    await removeAddedRepo(database, { workspaceId: ws.id, fullName: 'Zabaca/cedarpad' });
    await removeAddedRepo(database, { workspaceId: ws.id, fullName: 'vercel/next.js' });
    repos = await listWorkspaceRepos(database, ws.id);
    expect(repos.map((r) => [r.fullName, r.source])).toEqual([['Zabaca/cedarpad', 'installation']]);
  });

  test('adding a duplicate full name throws (unique per workspace)', async () => {
    const ws = await freshWorkspace('dup');
    await addPatRepo(database, { workspaceId: ws.id, fullName: 'a/b', encryptedToken: 't', addedByUserId: OWNER.id });
    await expect(
      addPatRepo(database, { workspaceId: ws.id, fullName: 'a/b', encryptedToken: 't2', addedByUserId: OWNER.id }),
    ).rejects.toThrow();
  });

  test('legacy selected_repos JSON is backfilled into rows once, then consumed', async () => {
    const ws = await freshWorkspace('legacy');
    await setWorkspaceSelectedRepos(database, { workspaceId: ws.id, repos: ['Zabaca/cedarpad', 'Zabaca/other'] });

    const repos = await listWorkspaceRepos(database, ws.id);
    expect(repos.map((r) => [r.fullName, r.source])).toEqual([
      ['Zabaca/cedarpad', 'installation'],
      ['Zabaca/other', 'installation'],
    ]);
    // The legacy column is consumed: deselecting everything later must NOT resurrect it.
    expect((await getWorkspaceRecord(database, ws.id))?.selectedRepos).toBeNull();
    await replaceInstallationRepos(database, { workspaceId: ws.id, repos: [] });
    expect(await listWorkspaceRepos(database, ws.id)).toEqual([]);
  });

  test('replacing the installation selection preserves PAT rows', async () => {
    const ws = await freshWorkspace('replace');
    await addPatRepo(database, { workspaceId: ws.id, fullName: 'hudsonts/app', encryptedToken: 't', addedByUserId: OWNER.id });
    await replaceInstallationRepos(database, { workspaceId: ws.id, repos: ['Zabaca/cedarpad'] });
    await replaceInstallationRepos(database, { workspaceId: ws.id, repos: ['Zabaca/next'] });

    const repos = await listWorkspaceRepos(database, ws.id);
    expect(repos.map((r) => [r.fullName, r.source]).sort()).toEqual([
      ['Zabaca/next', 'installation'],
      ['hudsonts/app', 'pat'],
    ]);
  });

  test('disconnecting the installation clears only installation rows', async () => {
    const ws = await freshWorkspace('disconnect');
    await addPatRepo(database, { workspaceId: ws.id, fullName: 'hudsonts/app', encryptedToken: 't', addedByUserId: OWNER.id });
    await replaceInstallationRepos(database, { workspaceId: ws.id, repos: ['Zabaca/cedarpad'] });

    await clearInstallationRepos(database, ws.id);
    const repos = await listWorkspaceRepos(database, ws.id);
    expect(repos.map((r) => [r.fullName, r.source])).toEqual([['hudsonts/app', 'pat']]);
  });
});
