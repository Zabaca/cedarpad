// The CONTAINER's credential on the asset door (#340) — how `read_image` gets at the
// pixels now that a shape's `src` is an `/api/canvas-assets/...` URL rather than an
// inline data URL (#290).
//
// Same trust root and same STATIC form as `canvas-mutate/v1` (shared/canvas-mutation.ts):
// this token never leaves the container↔edge hop, so the request-bound/expiring form the
// OPERATOR credential uses (#329) would buy nothing — that form exists because an
// operator token is handed to a shell or a CI job and travels separately from the secret.
//
// ITS OWN LABEL, deliberately, rather than reusing `canvas-asset/v1`:
//   - `canvas-asset/v1` is the label of the migration's UPLOAD door. Minting it here would
//     hand every chat turn a credential accepted for `PUT` — the ability to overwrite any
//     canvas's bytes — to satisfy a tool that only ever reads. The labels exist precisely
//     so one surface's token cannot be replayed on another.
//   - the two are different PRINCIPALS: `service:operator` is a human running a script,
//     `service:container` is the agent. Sharing a label would make the edge unable to tell
//     them apart in the one place it matters.
// The read door is therefore additionally method-gated to GET/HEAD (worker/canvas-assets.ts):
// this token is not a write capability even by accident.
//
// It grants no reach the container did not already have: `canvas-mutate/v1` already reads
// and writes the SHAPES of any canvas, and the asset bytes are strictly less than that.

import { serviceToken, verifyServiceToken } from './service-token.ts';

const TOKEN_LABEL = 'canvas-asset-read/v1';

export const canvasAssetReadToken = (secret: string): Promise<string> => serviceToken(secret, TOKEN_LABEL);

export const verifyCanvasAssetReadToken = (secret: string, presented: string): Promise<boolean> =>
  verifyServiceToken(secret, TOKEN_LABEL, presented);
