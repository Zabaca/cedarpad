// What a workspace's container may keep in the shared bucket, and the door it goes through.
//
// A container used to be handed the bucket's S3 access keys (R2_ACCESS_KEY_ID and
// R2_SECRET_ACCESS_KEY) and wrote straight to R2. Those keys reach the WHOLE bucket, so a
// container for workspace A could read or overwrite workspace B's objects, and the canvas
// images and retained blobs beside them, without touching the edge at all. The workspace key
// of #374 binds a container to its workspace at the edge; this closes the other path.
//
// The container now holds no R2 credential. The two things it persists go through the edge,
// which holds the bucket as a binding and chooses the key:
//
//   chat meta   GET|HEAD|PUT /api/workspace-blobs/<ws>/chat-meta
//   transcript  GET|HEAD|PUT /api/workspace-blobs/<ws>/transcripts/<sessionId>
//
// Both are authenticated by a bearer derived from the workspace's key (`workspace-blob/v1`),
// verified against the key of the workspace NAMED IN THE PATH, so a container can only ever
// address its own workspace's objects. The set of objects is closed: there is no verb for
// "any key", so a container cannot name a canvas asset, another workspace's prefix or a
// retained blob.

import { serviceToken, verifyServiceToken } from './service-token.ts';

/** The route prefix. */
export const WORKSPACE_BLOB_PATH = '/api/workspace-blobs';

/** HMAC label for the container's bearer on this door. Its own, so a token minted for the
 *  platform RPC or a canvas door cannot be replayed here. */
const TOKEN_LABEL = 'workspace-blob/v1';

export const workspaceBlobToken = (workspaceKey: string): Promise<string> => serviceToken(workspaceKey, TOKEN_LABEL);
export const verifyWorkspaceBlobToken = (workspaceKey: string, presented: string): Promise<boolean> =>
  verifyServiceToken(workspaceKey, TOKEN_LABEL, presented);

/** Workspace and session ids are flat tokens (uuids, `default`): no separator, no dots, so a
 *  path segment can never name a different prefix or climb out of one. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export type WorkspaceBlobRef =
  | { workspaceId: string; kind: 'chat-meta' }
  | { workspaceId: string; kind: 'transcript'; sessionId: string };

/** The route for a ref. */
export function workspaceBlobPath(ref: WorkspaceBlobRef): string {
  const base = `${WORKSPACE_BLOB_PATH}/${encodeURIComponent(ref.workspaceId)}`;
  return ref.kind === 'chat-meta' ? `${base}/chat-meta` : `${base}/transcripts/${encodeURIComponent(ref.sessionId)}`;
}

/** Is this path ours at all, whether or not it parses? The edge routes on THIS, so a path under the
 *  prefix that names no valid ref is answered 404 here instead of falling through to the session
 *  gate, which would answer a process with the login page at status 200. */
export const isWorkspaceBlobPath = (pathname: string): boolean =>
  pathname === WORKSPACE_BLOB_PATH || pathname.startsWith(`${WORKSPACE_BLOB_PATH}/`);

/** The ref a request path names, or null for anything else (including a malformed id). */
export function parseWorkspaceBlobPath(pathname: string): WorkspaceBlobRef | null {
  const meta = /^\/api\/workspace-blobs\/([^/]+)\/chat-meta$/.exec(pathname);
  const transcript = /^\/api\/workspace-blobs\/([^/]+)\/transcripts\/([^/]+)$/.exec(pathname);
  try {
    if (meta) {
      const workspaceId = decodeURIComponent(meta[1]!);
      return ID.test(workspaceId) ? { workspaceId, kind: 'chat-meta' } : null;
    }
    if (transcript) {
      const workspaceId = decodeURIComponent(transcript[1]!);
      const sessionId = decodeURIComponent(transcript[2]!);
      return ID.test(workspaceId) && ID.test(sessionId) ? { workspaceId, kind: 'transcript', sessionId } : null;
    }
  } catch {
    return null; // a malformed percent escape
  }
  return null;
}

/** The bucket key a ref is stored under. The EDGE derives it; the container never sends one. */
export function workspaceBlobKey(ref: WorkspaceBlobRef): string {
  return ref.kind === 'chat-meta'
    ? `workspaces/${ref.workspaceId}/chat-meta.json`
    : `workspaces/${ref.workspaceId}/sessions/${ref.sessionId}/transcript.jsonl`;
}

/** Where transcripts were kept before they were scoped to a workspace: one flat `sessions/`
 *  prefix shared by every workspace. Only the legacy `default` workspace, the one that wrote
 *  them, may still read them (worker/workspace-blobs-api.ts). */
export const legacyTranscriptKey = (sessionId: string): string => `sessions/${sessionId}/transcript.jsonl`;

/**
 * The container's side: which ref one of its blob keys is. The bridge's blob store speaks in
 * keys (`workspaces/<ws>/chat-meta.json`, `sessions/<id>/transcript.jsonl`); this maps the two
 * it is allowed to use onto the closed set above and refuses every other key, so a container
 * cannot be made to ask for anything outside it. A chat-meta key for ANOTHER workspace is
 * refused here too (and would be refused again by the edge).
 */
export function refForBlobKey(key: string, workspaceId: string): WorkspaceBlobRef | null {
  if (key === `workspaces/${workspaceId}/chat-meta.json`) return { workspaceId, kind: 'chat-meta' };
  const session = /^sessions\/([^/]+)\/transcript\.jsonl$/.exec(key);
  if (session && ID.test(session[1]!)) return { workspaceId, kind: 'transcript', sessionId: session[1]! };
  return null;
}
