import {
  legacyTranscriptKey,
  verifyWorkspaceBlobToken,
  workspaceBlobKey,
  type WorkspaceBlobRef,
} from '../shared/workspace-blob.ts';
import { workspaceKey } from '../shared/workspace-key.ts';

/** The slice of the Worker env this door reads. Declared here rather than imported from
 *  `./index.ts` for the reason `platform-rpc.ts` gives: the Worker entrypoint typechecks only under
 *  the worker tsconfig, and a node-side test drives this handler directly. `Env` satisfies it. */
export interface WorkspaceBlobEnv {
  BETTER_AUTH_SECRET?: string;
  /** The R2 bucket binding (structural: the three calls this door makes). Bodies are streams, so
   *  an object is never held whole in the isolate. */
  MART_BUCKET: {
    get(key: string): Promise<{ body: ReadableStream<Uint8Array>; size: number } | null>;
    head(key: string): Promise<{ size: number } | null>;
    put(key: string, value: ReadableStream<Uint8Array>): Promise<unknown>;
  };
}

// The door a workspace's container keeps its two objects through (shared/workspace-blob.ts).
//
// It SELF-GATES, like the other container doors: the caller is a process with no session, and
// the session gate's deny branch answers with login HTML at 200. The bearer is derived from the
// key of the workspace NAMED IN THE PATH (#374), so a container can only address its own
// workspace; the bucket key is derived here from the ref, never taken from the request, so
// there is no way to name an object outside the two kinds.

/**
 * The most a body may be. The largest session transcript in production is 5.7 MiB (136 of them,
 * median 0.3 MiB, measured 2026-11-10) and chat meta is a few KiB, so this leaves several times
 * the largest with room to grow, and it is a ceiling against a runaway, not a working size. It is
 * enforced on the declared length BEFORE the body is read, and nothing is buffered either way:
 * the Worker isolate has 128 MB, and an upload or a read at this size must not be able to take it.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

const status = (code: number, body: string | null = null) => new Response(body, { status: code });

/**
 * Read, probe or write one of a workspace's blobs.
 *
 * GET reads (404 when absent), HEAD probes, PUT replaces. Nothing here lists or deletes.
 * A transcript the workspace has no copy of in its own prefix is looked for at the legacy flat
 * key, for the legacy `default` workspace only: transcripts were not workspace-scoped before
 * this door, only `default` ever wrote them, and another workspace must not read them.
 *
 * Both directions STREAM. A PUT must declare its length (R2 needs one to take a stream, and it is
 * what the cap is checked against: 411 without one, 413 over the cap, both before a byte of the
 * body is read); a mismatch between the declared length and the body is the runtime's to refuse.
 */
export async function handleWorkspaceBlob(request: Request, env: WorkspaceBlobEnv, ref: WorkspaceBlobRef): Promise<Response> {
  const secret = env.BETTER_AUTH_SECRET;
  const presented = request.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!secret || !presented) return status(401, 'unauthorized');
  if (!(await verifyWorkspaceBlobToken(await workspaceKey(secret, ref.workspaceId), presented))) {
    return status(401, 'unauthorized');
  }

  const bucket = env.MART_BUCKET;
  const key = workspaceBlobKey(ref);

  if (request.method === 'PUT') {
    const declared = request.headers.get('content-length');
    if (declared === null || !/^\d+$/.test(declared)) return status(411, 'length required');
    if (Number(declared) > MAX_BODY_BYTES) return status(413, 'too large');
    if (!request.body) return status(400, 'a body is required');
    await bucket.put(key, request.body);
    return status(204);
  }

  if (request.method === 'GET' || request.method === 'HEAD') {
    const legacy = ref.kind === 'transcript' && ref.workspaceId === 'default' ? legacyTranscriptKey(ref.sessionId) : null;
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/octet-stream' };
    if (request.method === 'HEAD') {
      const found = (await bucket.head(key)) ?? (legacy ? await bucket.head(legacy) : null);
      return found ? new Response(null, { status: 200, headers: { ...headers, 'content-length': String(found.size) } }) : status(404, 'not found');
    }
    const object = (await bucket.get(key)) ?? (legacy ? await bucket.get(legacy) : null);
    if (!object) return status(404, 'not found');
    return new Response(object.body, { status: 200, headers: { ...headers, 'content-length': String(object.size) } });
  }

  return status(405, 'method not allowed');
}
