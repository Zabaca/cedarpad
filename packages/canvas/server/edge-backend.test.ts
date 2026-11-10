import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { workspaceKey } from '../shared/workspace-key.ts';
import { bucketStub } from '../worker/blob-bucket-stub.ts';
import { handleWorkspaceBlob } from '../worker/workspace-blobs-api.ts';
import { parseWorkspaceBlobPath, workspaceBlobToken } from '../shared/workspace-blob.ts';
import { chatMetaKey, edgeBackend, fsBackend, selectBackend } from './blob-store.ts';
import { transcriptKey } from './transcript-store.ts';

// A container keeps two objects through the edge and holds no R2 credential (#374 follow-up).
// The backend is tested over the REAL edge handler and a bucket stub, so the two halves are
// proven to agree on routes, bearer and keys, and what a container cannot reach is shown at the
// bucket, not just at the client.

const SECRET = 'test-secret-at-least-32-characters-long!!';
const ORIGIN = 'https://edge.test';

/** The edge, as a fetch: routes to the real handler the way worker/index.ts does. */
const edgeFetch = (b: ReturnType<typeof bucketStub>, calls: string[] = []) => async (input: string, init: RequestInit) => {
  calls.push(`${init.method} ${input}`);
  // The runtime stamps a request's length; a Request built here does not.
  const length: Record<string, string> = init.body instanceof Blob ? { 'content-length': String(init.body.size) } : {};
  const request = new Request(input, { ...init, headers: { ...(init.headers as Record<string, string>), ...length } });
  const ref = parseWorkspaceBlobPath(new URL(input).pathname);
  if (!ref) return new Response('not found', { status: 404 });
  return handleWorkspaceBlob(request, { MART_BUCKET: b.bucket, BETTER_AUTH_SECRET: SECRET } as never, ref);
};

const backendFor = async (workspaceId: string, b: ReturnType<typeof bucketStub>, calls: string[] = []) =>
  edgeBackend({ origin: ORIGIN, workspaceKey: await workspaceKey(SECRET, workspaceId), workspaceId, fetchImpl: edgeFetch(b, calls) });

describe('edgeBackend over the real edge handler', () => {
  test('chat meta and a transcript round-trip, stored under this workspace', async () => {
    const b = bucketStub();
    const backend = await backendFor('ws_a', b);

    await backend.put(chatMetaKey('ws_a'), new TextEncoder().encode('{"chat":1}'));
    await backend.put(transcriptKey('s1'), new TextEncoder().encode('line\n'));

    expect([...b.objects.keys()].sort()).toEqual(['workspaces/ws_a/chat-meta.json', 'workspaces/ws_a/sessions/s1/transcript.jsonl']);
    expect(new TextDecoder().decode((await backend.get(chatMetaKey('ws_a')))!)).toBe('{"chat":1}');
    expect(new TextDecoder().decode((await backend.get(transcriptKey('s1')))!)).toBe('line\n');
    expect(await backend.exists(transcriptKey('s1'))).toBe(true);
  });

  test('an absent object is null and false; any other failure THROWS, so it never reads as empty history', async () => {
    const b = bucketStub();
    const backend = await backendFor('ws_a', b);
    expect(await backend.get(chatMetaKey('ws_a'))).toBeNull();
    expect(await backend.exists(chatMetaKey('ws_a'))).toBe(false);

    const refused = edgeBackend({ origin: ORIGIN, workspaceKey: 'not-the-key', workspaceId: 'ws_a', fetchImpl: edgeFetch(b) });
    await expect(refused.get(chatMetaKey('ws_a'))).rejects.toThrow(/refused.*401/);
    await expect(refused.put(chatMetaKey('ws_a'), new Uint8Array([1]))).rejects.toThrow(/refused.*401/);

    const down = edgeBackend({ origin: ORIGIN, workspaceKey: 'k', workspaceId: 'ws_a', fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
    await expect(down.get(chatMetaKey('ws_a'))).rejects.toThrow(/ECONNREFUSED/);
  });

  // The point: with no R2 credential and only this door, another workspace's objects, the canvas
  // images and the retained blobs cannot be named at all.
  test('the container cannot name another workspace, a canvas asset or a retained blob: refused before any request', async () => {
    const b = bucketStub({ 'workspaces/ws_b/chat-meta.json': 'b', 'canvas-assets/c1/k.png': 'img', 'workspaces/ws_a/canvases/c1/canvas-state.json': 's' });
    const calls: string[] = [];
    const backend = await backendFor('ws_a', b, calls);

    for (const key of [
      chatMetaKey('ws_b'),
      'workspaces/ws_b/sessions/x/transcript.jsonl',
      'canvas-assets/c1/k.png',
      'workspaces/ws_a/canvases/c1/canvas-state.json',
      'workspaces/ws_a/shared-components.tar',
    ]) {
      await expect(backend.get(key), key).rejects.toThrow(/may not use/);
      await expect(backend.put(key, new Uint8Array([1])), key).rejects.toThrow(/may not use/);
      await expect(backend.exists(key), key).rejects.toThrow(/may not use/);
    }
    expect(calls).toEqual([]);
    expect(b.touched).toEqual([]);
  });

  test('and a container that forges the path itself is still held to its workspace by the edge', async () => {
    const b = bucketStub({ 'workspaces/ws_b/chat-meta.json': 'b-secret' });
    // ws_a's key, B's route: what a compromised container could send by hand.
    const res = await edgeFetch(b)(`${ORIGIN}/api/workspace-blobs/ws_b/chat-meta`, {
      method: 'GET',
      headers: { authorization: `Bearer ${await workspaceBlobToken(await workspaceKey(SECRET, 'ws_a'))}` },
    });
    expect(res.status).toBe(401);
    expect(b.touched).toEqual([]);
  });

  test('there is no listing', async () => {
    await expect((await backendFor('ws_a', bucketStub())).list('workspaces/')).rejects.toThrow(/cannot list/);
  });

  test('transcripts the legacy default workspace wrote before scoping are still readable by it', async () => {
    const b = bucketStub({ 'sessions/old/transcript.jsonl': 'legacy' });
    expect(new TextDecoder().decode((await (await backendFor('default', b)).get(transcriptKey('old')))!)).toBe('legacy');
    expect(await (await backendFor('ws_a', b)).get(transcriptKey('old'))).toBeNull();
  });
});

describe('selectBackend', () => {
  test('the local disk by default, and R2 is never selected, even with R2 variables present', async () => {
    // A directory of its own, so this never touches a shared path (CLAUDE.md §6).
    const dir = mkdtempSync(join(tmpdir(), 'edge-backend-'));
    try {
      const backend = selectBackend(dir, { R2_BUCKET: 'some-bucket', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 'b' });
      // It IS the disk backend: a write lands under `dir`, and an absent key is null, not an S3 call.
      expect(await backend.get('workspaces/x/chat-meta.json')).toBeNull();
      await backend.put('workspaces/x/chat-meta.json', new Uint8Array([1, 2]));
      expect(existsSync(join(dir, 'workspaces/x/chat-meta.json'))).toBe(true);
      expect(await fsBackend(dir).get('workspaces/x/chat-meta.json')).toEqual(new Uint8Array([1, 2]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the edge door when told to, and a half-configured container fails loudly rather than falling back', () => {
    const dir = join(tmpdir(), 'edge-backend-never-created');
    const told = { WORKSPACE_BLOBS: 'edge', PLATFORM_RPC_ORIGIN: ORIGIN };
    expect(() => selectBackend(dir, told)).toThrow(/WORKSPACE_KEY/);
    expect(() => selectBackend(dir, { WORKSPACE_BLOBS: 'edge', WORKSPACE_KEY: 'k' })).toThrow(/PLATFORM_RPC_ORIGIN/);
    expect(() => selectBackend(dir, { ...told, WORKSPACE_KEY: 'k' })).not.toThrow();
  });
});
