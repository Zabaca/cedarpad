import { describe, expect, test } from 'bun:test';

import { chatMetaKey } from '../server/blob-store.ts';
import { transcriptKey } from '../server/transcript-store.ts';
import { canvasMutateToken } from './canvas-mutation.ts';
import {
  isWorkspaceBlobPath,
  legacyTranscriptKey,
  parseWorkspaceBlobPath,
  refForBlobKey,
  verifyWorkspaceBlobToken,
  workspaceBlobKey,
  workspaceBlobPath,
  workspaceBlobToken,
  type WorkspaceBlobRef,
} from './workspace-blob.ts';
import { workspaceKey } from './workspace-key.ts';

const SECRET = 'test-secret-at-least-32-characters-long!!';

describe('the route and the key a ref has', () => {
  const refs: WorkspaceBlobRef[] = [
    { workspaceId: 'default', kind: 'chat-meta' },
    { workspaceId: 'ws_1', kind: 'transcript', sessionId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
  ];

  test('a path round-trips to the ref it was made from', () => {
    for (const ref of refs) expect(parseWorkspaceBlobPath(workspaceBlobPath(ref))).toEqual(ref);
  });

  test('the bucket key of a ref is the key the bridge already used, so nothing already stored moves', () => {
    expect(workspaceBlobKey(refs[0]!)).toBe(chatMetaKey('default'));
    // Transcripts gain their workspace: the legacy flat key is `transcriptKey(id)`.
    expect(legacyTranscriptKey('abc')).toBe(transcriptKey('abc'));
    expect(workspaceBlobKey(refs[1]!)).toBe('workspaces/ws_1/sessions/0f8fad5b-d9cb-469f-a165-70867728950e/transcript.jsonl');
  });
});

describe('parseWorkspaceBlobPath refuses anything that is not a flat id', () => {
  test('traversal, separators, dots and escapes', () => {
    for (const bad of [
      '/api/workspace-blobs/../chat-meta',
      '/api/workspace-blobs/ws_1/transcripts/..',
      '/api/workspace-blobs/ws_1/transcripts/a%2Fb',
      '/api/workspace-blobs/ws%2F1/chat-meta',
      '/api/workspace-blobs/ws.1/chat-meta',
      '/api/workspace-blobs/ws_1/transcripts/a.b',
      '/api/workspace-blobs/ws_1/transcripts/%E0%A4%A',
      '/api/workspace-blobs//chat-meta',
      `/api/workspace-blobs/${'x'.repeat(129)}/chat-meta`,
    ]) {
      expect(parseWorkspaceBlobPath(bad), bad).toBeNull();
    }
  });

  test('other routes and other kinds are not ours', () => {
    for (const other of ['/api/workspace-blobs', '/api/workspace-blobs/ws_1', '/api/workspace-blobs/ws_1/canvas-assets/x', '/api/platform-rpc']) {
      expect(parseWorkspaceBlobPath(other), other).toBeNull();
    }
  });
});

describe('refForBlobKey: the only two keys a container may use', () => {
  test('its own chat meta, and a session transcript, in its own workspace', () => {
    expect(refForBlobKey(chatMetaKey('ws_1'), 'ws_1')).toEqual({ workspaceId: 'ws_1', kind: 'chat-meta' });
    expect(refForBlobKey(transcriptKey('abc-123'), 'ws_1')).toEqual({ workspaceId: 'ws_1', kind: 'transcript', sessionId: 'abc-123' });
  });

  test("another workspace's chat meta is refused", () => {
    expect(refForBlobKey(chatMetaKey('ws_2'), 'ws_1')).toBeNull();
  });

  test('every other key is refused: canvas assets, retained blobs, archives, other prefixes, traversal', () => {
    for (const key of [
      'canvas-assets/c1/k.png',
      'workspaces/ws_1/canvases/c1/canvas-state.json',
      'workspaces/ws_1/shared-components.tar',
      'workspaces/ws_2/sessions/abc/transcript.jsonl',
      'sessions/a/b/transcript.jsonl',
      'sessions/../transcript.jsonl',
      'sessions/a.b/transcript.jsonl',
      'sessions//transcript.jsonl',
      '',
    ]) {
      expect(refForBlobKey(key, 'ws_1'), key).toBeNull();
    }
  });
});

describe('the bearer', () => {
  test('verifies against its own workspace key and no other', async () => {
    const a = await workspaceBlobToken(await workspaceKey(SECRET, 'ws_a'));
    expect(await verifyWorkspaceBlobToken(await workspaceKey(SECRET, 'ws_a'), a)).toBe(true);
    expect(await verifyWorkspaceBlobToken(await workspaceKey(SECRET, 'ws_b'), a)).toBe(false);
  });

  test('is not another surface\'s bearer', async () => {
    const key = await workspaceKey(SECRET, 'ws_a');
    expect(await verifyWorkspaceBlobToken(key, await canvasMutateToken(key))).toBe(false);
  });
});

// The edge routes on the PREFIX, so a path under it that names no blob is this door's 404 and never
// falls through to the session gate (which answers a process with the login page at 200).
describe('isWorkspaceBlobPath', () => {
  test('everything under the prefix is ours, parseable or not', () => {
    for (const path of ['/api/workspace-blobs', '/api/workspace-blobs/', '/api/workspace-blobs/ws_1', '/api/workspace-blobs/../x', '/api/workspace-blobs/ws_1/chat-meta', '/api/workspace-blobs/ws.1/chat-meta', '/api/workspace-blobs/ws_1/transcripts/a%2Fb']) {
      expect(isWorkspaceBlobPath(path), path).toBe(true);
    }
  });

  test('a neighbour that only shares the text is not', () => {
    for (const path of ['/api/workspace-blobsx', '/api/workspace-blob/ws_1/chat-meta', '/api/platform-rpc', '/']) {
      expect(isWorkspaceBlobPath(path), path).toBe(false);
    }
  });

  test('every path that is ours and does not parse is exactly what the edge answers 404', () => {
    const unparseable = ['/api/workspace-blobs', '/api/workspace-blobs/ws_1', '/api/workspace-blobs/ws.1/chat-meta', '/api/workspace-blobs/ws_1/transcripts/a%2Fb'];
    for (const path of unparseable) expect(isWorkspaceBlobPath(path) && parseWorkspaceBlobPath(path) === null, path).toBe(true);
  });
});
