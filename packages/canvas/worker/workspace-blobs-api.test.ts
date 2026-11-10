import { describe, expect, test } from 'bun:test';

import { canvasMutateToken } from '../shared/canvas-mutation.ts';
import { workspaceBlobPath, workspaceBlobToken, type WorkspaceBlobRef } from '../shared/workspace-blob.ts';
import { workspaceKey } from '../shared/workspace-key.ts';
import { bucketStub, trackedBody } from './blob-bucket-stub.ts';
import { handleWorkspaceBlob, MAX_BODY_BYTES } from './workspace-blobs-api.ts';

const SECRET = 'test-secret-at-least-32-characters-long!!';


const env = (b: ReturnType<typeof bucketStub>, secret: string | null = SECRET) => ({ MART_BUCKET: b.bucket, ...(secret ? { BETTER_AUTH_SECRET: secret } : {}) }) as never;
const bearerFor = async (workspaceId: string) => `Bearer ${await workspaceBlobToken(await workspaceKey(SECRET, workspaceId))}`;

const call = async (
  b: ReturnType<typeof bucketStub>,
  ref: WorkspaceBlobRef,
  opts: { method?: string; auth?: string | null; body?: string; secret?: string | null; headers?: Record<string, string> } = {},
) => {
  const auth = opts.auth === undefined ? await bearerFor(ref.workspaceId) : opts.auth;
  return handleWorkspaceBlob(
    new Request(`https://app.test${workspaceBlobPath(ref)}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(auth ? { authorization: auth } : {}),
        // The runtime stamps a request's length; a Request built here does not.
        ...(opts.body !== undefined ? { 'content-length': String(new TextEncoder().encode(opts.body).byteLength) } : {}),
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: opts.body } : {}),
    }),
    env(b, opts.secret === undefined ? SECRET : opts.secret),
    ref,
  );
};

const META: WorkspaceBlobRef = { workspaceId: 'ws_a', kind: 'chat-meta' };
const TRANSCRIPT: WorkspaceBlobRef = { workspaceId: 'ws_a', kind: 'transcript', sessionId: 'sess-1' };

describe('a container reads and writes its own workspace\'s two objects', () => {
  test('PUT stores under the workspace-scoped key the EDGE derives, and GET reads it back', async () => {
    const b = bucketStub();
    expect((await call(b, META, { method: 'PUT', body: '{"c":1}' })).status).toBe(204);
    expect((await call(b, TRANSCRIPT, { method: 'PUT', body: 'line1\n' })).status).toBe(204);
    expect([...b.objects.keys()].sort()).toEqual(['workspaces/ws_a/chat-meta.json', 'workspaces/ws_a/sessions/sess-1/transcript.jsonl']);

    const res = await call(b, TRANSCRIPT);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('line1\n');
  });

  test('GET of an absent object is a 404, not an empty body', async () => {
    expect((await call(bucketStub(), META)).status).toBe(404);
  });

  test('HEAD probes without a body', async () => {
    const b = bucketStub({ 'workspaces/ws_a/chat-meta.json': '{}' });
    const res = await call(b, META, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect((await call(bucketStub(), META, { method: 'HEAD' })).status).toBe(404);
  });

  test('there is no delete and no other verb', async () => {
    const b = bucketStub({ 'workspaces/ws_a/chat-meta.json': '{}' });
    for (const method of ['DELETE', 'POST', 'PATCH']) {
      expect((await call(b, META, { method })).status, method).toBe(405);
    }
    expect(b.objects.size).toBe(1);
  });
});

// The point of the door: a container for workspace A is held to workspace A's objects.
describe('another workspace\'s objects are out of reach', () => {
  test("A's bearer cannot read, probe or write B's, whichever route names B", async () => {
    const b = bucketStub({ 'workspaces/ws_b/chat-meta.json': 'b-secret', 'workspaces/ws_b/sessions/s/transcript.jsonl': 'b-chat' });
    const asA = await bearerFor('ws_a');
    for (const ref of [
      { workspaceId: 'ws_b', kind: 'chat-meta' } as const,
      { workspaceId: 'ws_b', kind: 'transcript', sessionId: 's' } as const,
    ]) {
      for (const method of ['GET', 'HEAD', 'PUT']) {
        const res = await call(b, ref, { method, auth: asA, ...(method === 'PUT' ? { body: 'overwrite' } : {}) });
        expect(res.status, `${method} ${ref.kind}`).toBe(401);
      }
    }
    expect(b.touched).toEqual([]);
    expect(new TextDecoder().decode(b.objects.get('workspaces/ws_b/chat-meta.json')!)).toBe('b-secret');
  });

  test('no bearer, a wrong one, another surface\'s, and an edge with no secret are all refused before the bucket', async () => {
    const b = bucketStub({ 'workspaces/ws_a/chat-meta.json': '{}' });
    const key = await workspaceKey(SECRET, 'ws_a');
    for (const auth of [null, 'Bearer nope', `Bearer ${await canvasMutateToken(key)}`]) {
      expect((await call(b, META, { auth })).status, String(auth)).toBe(401);
    }
    expect((await call(b, META, { secret: null })).status).toBe(401);
    expect(b.touched).toEqual([]);
  });

  test('the old constant bearer derived from the secret opens nothing', async () => {
    const b = bucketStub({ 'workspaces/ws_a/chat-meta.json': '{}' });
    const res = await call(b, META, { auth: `Bearer ${await workspaceBlobToken(SECRET)}` });
    expect(res.status).toBe(401);
    expect(b.touched).toEqual([]);
  });

  test('the bucket key comes from the ref, so no request can steer it elsewhere', async () => {
    const b = bucketStub();
    // A session id that is not a flat id never reaches the handler (the route refuses it), and a ref
    // that does is always keyed under its own workspace.
    await call(b, { workspaceId: 'ws_a', kind: 'transcript', sessionId: 's' }, { method: 'PUT', body: 'x' });
    expect([...b.objects.keys()]).toEqual(['workspaces/ws_a/sessions/s/transcript.jsonl']);
  });
});

describe('transcripts written before they were scoped to a workspace', () => {
  const legacy = { 'sessions/old-1/transcript.jsonl': 'legacy chat' };

  test('the legacy `default` workspace can still read its own old transcripts', async () => {
    const b = bucketStub(legacy);
    const res = await call(b, { workspaceId: 'default', kind: 'transcript', sessionId: 'old-1' });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('legacy chat');
  });

  test('its own scoped copy wins once it has one', async () => {
    const b = bucketStub({ ...legacy, 'workspaces/default/sessions/old-1/transcript.jsonl': 'newer' });
    expect(await (await call(b, { workspaceId: 'default', kind: 'transcript', sessionId: 'old-1' })).text()).toBe('newer');
  });

  test('no other workspace can read them', async () => {
    const b = bucketStub(legacy);
    const res = await call(b, { workspaceId: 'ws_a', kind: 'transcript', sessionId: 'old-1' });
    expect(res.status).toBe(404);
    expect(b.touched).toEqual(['workspaces/ws_a/sessions/old-1/transcript.jsonl']);
  });

  test('writes never go to the legacy key', async () => {
    const b = bucketStub(legacy);
    await call(b, { workspaceId: 'default', kind: 'transcript', sessionId: 'old-1' }, { method: 'PUT', body: 'new' });
    expect(new TextDecoder().decode(b.objects.get('sessions/old-1/transcript.jsonl')!)).toBe('legacy chat');
    expect(b.objects.has('workspaces/default/sessions/old-1/transcript.jsonl')).toBe(true);
  });
});

// Both directions stream: nothing is held whole in the isolate (128 MB), and the cap is a ceiling
// checked on the declared length before a byte is read.
describe('streaming and the size cap', () => {
  const put = (b: ReturnType<typeof bucketStub>, headers: Record<string, string>, body: ReadableStream<Uint8Array>) =>
    bearerFor('ws_a').then((auth) =>
      handleWorkspaceBlob(
        new Request(`https://app.test${workspaceBlobPath(TRANSCRIPT)}`, { method: 'PUT', headers: { authorization: auth, ...headers }, body, duplex: 'half' } as RequestInit),
        env(b),
        TRANSCRIPT,
      ),
    );

  test('a body over the cap is a 413 and its body is never read, and nothing reaches the bucket', async () => {
    const b = bucketStub();
    const { stream, state } = trackedBody(1024);
    const res = await put(b, { 'content-length': String(MAX_BODY_BYTES + 1) }, stream);
    expect(res.status).toBe(413);
    expect(state.pulls).toBe(0);
    expect(b.puts).toBe(0);
    expect(b.touched).toEqual([]);
  });

  test('a body at the cap is accepted', async () => {
    const b = bucketStub();
    const { stream } = trackedBody(1024);
    expect((await put(b, { 'content-length': String(MAX_BODY_BYTES) }, stream)).status).toBe(204);
    expect(b.puts).toBe(1);
  });

  test('a PUT that declares no length (or a bad one) is a 411 before the body is read', async () => {
    for (const headers of [{}, { 'content-length': 'abc' }, { 'content-length': '-5' }]) {
      const b = bucketStub();
      const { stream, state } = trackedBody(10);
      expect((await put(b, headers, stream)).status, JSON.stringify(headers)).toBe(411);
      expect(state.pulls).toBe(0);
      expect(b.puts).toBe(0);
    }
  });

  test('the bucket receives the request body as a stream, not a buffer', async () => {
    let received: unknown;
    const b = bucketStub();
    const inner = b.bucket.put;
    b.bucket.put = async (key, value) => {
      received = value;
      return inner(key, value);
    };
    const { stream } = trackedBody(10);
    await put(b, { 'content-length': '10' }, stream);
    expect(received).toBeInstanceOf(ReadableStream);
  });

  test('a read is the object\'s own stream with its length, for GET and HEAD, legacy fallback included', async () => {
    const b = bucketStub({ 'workspaces/ws_a/sessions/sess-1/transcript.jsonl': 'abcdef', 'sessions/old/transcript.jsonl': 'legacy!' });
    const got = await call(b, TRANSCRIPT);
    expect(got.headers.get('content-length')).toBe('6');
    expect(got.body).toBeInstanceOf(ReadableStream);
    expect(await got.text()).toBe('abcdef');

    const head = await call(b, TRANSCRIPT, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('6');

    const legacy = { workspaceId: 'default', kind: 'transcript', sessionId: 'old' } as const;
    expect((await call(b, legacy, { method: 'HEAD' })).headers.get('content-length')).toBe('7');
    expect(await (await call(b, legacy)).text()).toBe('legacy!');
  });
});
