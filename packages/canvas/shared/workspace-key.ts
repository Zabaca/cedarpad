// The ONE credential a workspace's container holds for talking back to the edge (#374).
//
// Before this, the container was handed BETTER_AUTH_SECRET itself and derived every bearer
// it presents (platform RPC, canvas mutation, asset read) as `HMAC(secret, <label>)`. Those
// bearers are constants: they encode no workspace, so every container in the deployment
// minted the identical string, and anything that could run code in one container could
// mint it and name ANY workspace's canvas in the payload. The edge's ownership checks
// ("is this canvas in the workspace you named?") reject a mismatched pair and cannot reject
// a consistent pair that belongs to someone else.
//
// The fix binds the workspace to the CREDENTIAL, not to the payload the caller composes:
//
//     workspaceKey(secret, W)  = HMAC(secret, 'workspace-key/v1:' + W)      (the container's only credential)
//     bearer(label)            = HMAC(workspaceKey, label)                  (per surface, as before)
//
// The container is handed `workspaceKey` for its own workspace and nothing else, and derives
// its per-surface bearers from it exactly as it used to derive them from the secret. The
// edge, which holds the secret, learns which workspace a request claims (the payload's
// `workspaceId`, or the workspace of the canvas in the path), derives THAT workspace's key,
// and verifies the bearer against it. A key for workspace A verifies nothing claimed for
// workspace B, and the secret cannot be recovered from a key, so a compromised container can
// act as its own workspace only. A container holds no other credential that reaches shared
// storage: it has no R2 keys either (shared/workspace-blob.ts).
//
// Rotation is unchanged in kind: rotating BETTER_AUTH_SECRET rotates every key (and signs
// every user out), and a workspace's key reaches the container with its other env at boot.

import { serviceToken } from './service-token.ts';

/** HMAC message prefix. Distinct from every surface label (`platform-rpc/v1`,
 *  `canvas-mutate/v1`, `canvas-asset-read/v1`), so a key can never be replayed as a bearer. */
export const WORKSPACE_KEY_LABEL = 'workspace-key/v1:';

/** The key for one workspace. Edge-side only in production: the container receives it. */
export const workspaceKey = (secret: string, workspaceId: string): Promise<string> =>
  serviceToken(secret, `${WORKSPACE_KEY_LABEL}${workspaceId}`);
