import type { Database } from '../web-poc/lib/db/client.ts';
import { getWorkspaceRecord } from '../web-poc/lib/db/queries/workspaces.ts';
import {
  type ComponentHistoryOutput,
  type ComponentListOutput,
  type ComponentReadOutput,
  type ComponentRestoreOutput,
  type ComponentWriteOutput,
  type DataReadOutput,
  type DataWriteOutput,
  PlatformRpcRequest,
  type SkillListOutput,
  type SkillWriteOutput,
  verifyPlatformRpcToken,
} from '../shared/platform-rpc.ts';
import { workspaceKey } from '../shared/workspace-key.ts';
import { workspaceOfCanvas } from './canvas-workspace.ts';
import { componentCatalog } from './component-catalog.ts';
import { componentStore } from './component-store.ts';
import { dataStore } from './data-store.ts';
import { d1RecordStore } from './record-store.ts';
import { d1SkillFileStore } from './skill-file-store.ts';
import { skillStore } from './skill-store.ts';
import { DEFAULT_WORKSPACE_ID } from './shell-routing.ts';

// The edge half of the platform RPC (ADR-0018). See `shared/platform-rpc.ts` for the contract
// and for why this is a behavioural surface rather than a data-access one.

/**
 * The slice of the Worker env this route reads. Declared here rather than imported from
 * `./index.ts` on purpose: the Worker entrypoint typechecks only under the worker tsconfig
 * (`@cloudflare/workers-types`), so importing its `Env` would drag the whole entrypoint into
 * the program of any node-side caller that drives this handler directly — which the #365
 * migration does, deliberately, so that its local dry run goes through the REAL edge handler
 * rather than a stand-in. `Env` still satisfies this.
 */
export type PlatformRpcEnv = {
  BETTER_AUTH_SECRET?: string;
};

/** The collaborators the operations need. Default-parameter seam (as `bridge.ts` uses), so
 * tests drive the real handler against an in-memory platform data layer. */
export interface PlatformRpcDeps {
  db: Database;
}

/** The production wiring, minus the platform-data-layer client (the caller passes the one the
 * edge already builds — this module stays free of `web-poc/worker/runtime.ts`, so a bun test
 * can import it without the workerd-only libSQL client coming along). */
export function platformRpcDeps(db: Database): PlatformRpcDeps {
  return { db };
}

/**
 * Bearer check (#374): the caller must present the bearer derived from the key of the workspace
 * it NAMES. The bearer is `HMAC(workspaceKey(secret, W), 'platform-rpc/v1')`, so it verifies for
 * exactly one workspace id, and the edge learns which one to check from the payload's
 * `workspaceId`: a container for workspace A that names workspace B derives B's key here and
 * its bearer fails. The credential, not the payload, decides which workspace a caller is.
 *
 * Runs BEFORE the contract parse, so it reads only the one field it needs, loosely: a body with no
 * workspace id string has nothing to authenticate against and is the same 401 as no bearer.
 * Once it passes, `canvasBelongsToWorkspace` and `workspaceExists` below are tenancy checks, not
 * only consistency ones: the workspace they test is the one the caller's credential names.
 */
async function authorized(secret: string, presented: string, body: unknown): Promise<boolean> {
  const claimed = (body as { input?: { workspaceId?: unknown } } | null)?.input?.workspaceId;
  if (typeof claimed !== 'string' || claimed === '') return false;
  return verifyPlatformRpcToken(await workspaceKey(secret, claimed), presented);
}

/**
 * Ownership for a Record write (ADR-0022): the named canvas must actually belong to the
 * named workspace. The container says which workspace it is writing for; the EDGE decides
 * whether that is true, because a payload the container composes cannot be its own
 * authorization. The legacy `default` canvas has no registry row and is therefore pinned to
 * the legacy `default` workspace by hand.
 */
async function canvasBelongsToWorkspace(db: Database, workspaceId: string, canvasId: string): Promise<boolean> {
  return (await workspaceOfCanvas(db, canvasId)) === workspaceId;
}

/**
 * Ownership for a WORKSPACE-SCOPED Record write (ADR-0022) — Workspace skills (#361), which
 * have no canvas to contain them. With only one coordinate there is no containment to check,
 * so the check is that the workspace is REAL: the container names the workspace it is writing
 * for, and a forged or typo'd id must not quietly mint rows nobody can ever reach.
 *
 * The shared Component tier (#359) raised the same question and answered it WITHOUT needing
 * this: a shared Component operation names the canvas it acts from, so the containment check
 * above still applies and `tierCanvas` mints the null key here. Skills have no such canvas, so
 * this stays the weaker of the two, and with the bearer bound to the workspace it names (#374)
 * the caller can only name its own, so "is it real" is all that is left to ask.
 *
 * The legacy `default` workspace has no `workspaces` row (it predates the registry, exactly as
 * the legacy `default` canvas does) and is therefore pinned by hand, like `canvasBelongsToWorkspace`.
 */
async function workspaceExists(db: Database, workspaceId: string): Promise<boolean> {
  if (workspaceId === DEFAULT_WORKSPACE_ID) return true;
  return (await getWorkspaceRecord(db, workspaceId)) !== null;
}

/**
 * The Record key's canvas, minted HERE and never accepted from the container. The shared
 * tier is `canvas_id NULL`, and null is precisely the value `canvasBelongsToWorkspace` cannot
 * verify — so the container names a real canvas, that canvas is checked, and only then does
 * the edge decide the operation addresses the workspace's shared library instead of the
 * canvas's own. A caller cannot reach a workspace's shared library without naming a canvas
 * the registry places inside it, which is exactly the check an own-tier write already passes.
 */
const tierCanvas = (tier: 'own' | 'shared', canvasId: string): string | null => (tier === 'shared' ? null : canvasId);

/** `POST /api/platform-rpc` — the named operations, nothing else. */
export async function handlePlatformRpc(request: Request, env: PlatformRpcEnv, deps: PlatformRpcDeps): Promise<Response> {
  const secret = env.BETTER_AUTH_SECRET;
  const presented = request.headers.get('authorization')?.replace(/^Bearer /, '');
  // No secret or no bearer is a 401 before any body is read.
  if (!secret || !presented) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const body: unknown = await request.json().catch(() => null);
  if (!(await authorized(secret, presented, body))) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // Parse at the boundary (CLAUDE.md §7): an unparseable body is a contract violation, not a
  // dispatchable operation.
  const parsed = PlatformRpcRequest.safeParse(body);
  if (!parsed.success) return Response.json({ error: 'invalid request' }, { status: 400 });

  // The Record verbs (ADR-0022). Validation already happened in the parse above — the name
  // rule and the non-empty rule are IN the contract, so a bad payload is a 400 here and never
  // something the store has to be trusted to catch. What is left is ownership, then the write.
  if (parsed.data.op === 'component.write') {
    const { workspaceId, canvasId, tier, userId, name, source } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    // Deliberately NOT caught: a store failure must reach the container as a non-2xx so the
    // tool call fails and the agent retries. Swallowing it here is the 2026-07-29 shape.
    const { rev } = await componentStore(d1RecordStore(deps.db)).write({
      workspaceId,
      canvasId: tierCanvas(tier, canvasId),
      name,
      source,
      userId,
    });
    return Response.json({ rev } satisfies ComponentWriteOutput);
  }

  if (parsed.data.op === 'component.read') {
    const { workspaceId, canvasId, tier, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const source = await componentStore(d1RecordStore(deps.db)).read({
      workspaceId,
      canvasId: tierCanvas(tier, canvasId),
      name,
    });
    return Response.json({ source } satisfies ComponentReadOutput);
  }

  // "Who changed this Component, and when" — the question nothing in this product could
  // answer before Records. Gated by the same ownership check as a read, because a history is
  // a read: the names in it are members of the workspace that owns the canvas.
  if (parsed.data.op === 'component.history') {
    const { workspaceId, canvasId, tier, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const versions = await componentStore(d1RecordStore(deps.db)).history({
      workspaceId,
      canvasId: tierCanvas(tier, canvasId),
      name,
    });
    return Response.json({ versions } satisfies ComponentHistoryOutput);
  }

  // "Put this Component back the way it was at version N" (#362). The read-then-put happens
  // HERE, on the side that owns the rows: the container named a version, not a source, so the
  // old text never left this process and no payload the container composes could stand in for
  // it. Gated as a WRITE, because it is one — an unrestricted restore would be a way to reach
  // into another workspace's canvas and make an old revision current there.
  if (parsed.data.op === 'component.restore') {
    const { workspaceId, canvasId, tier, userId, name, version } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    // Store failures are, as above, deliberately NOT caught. A version that does not exist is
    // a different thing entirely — the caller asked for something that was never written — so
    // it is an answer with a status, not an exception, and above all not a silent success.
    const restored = await componentStore(d1RecordStore(deps.db)).restore({
      workspaceId,
      canvasId: tierCanvas(tier, canvasId),
      name,
      version,
      userId,
    });
    if (!restored) return Response.json({ error: 'no such version' }, { status: 404 });
    return Response.json({ rev: restored.rev } satisfies ComponentRestoreOutput);
  }

  // "What can this canvas place?" — all three tiers in one answer (#363). The container asks
  // rather than reading its own directories because, after a recycle, those directories are
  // empty while the Records are not: a disk-only listing would report a library the workspace
  // still has, and the next turn would author a duplicate of everything in it. It also keeps
  // the container's answer and the edge's the SAME answer, from one implementation.
  if (parsed.data.op === 'component.list') {
    const { workspaceId, canvasId } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const components = await componentCatalog(d1RecordStore(deps.db), { workspaceId, canvasId });
    return Response.json({ components } satisfies ComponentListOutput);
  }

  // The Workspace-skill verbs (#361). Same rules as the Component pair above — the contract
  // already rejected a bad skill name or file path with a 400, so what is left is ownership,
  // then the write — and the same deliberate absence of a try/catch: a store failure must
  // reach the container as a non-2xx so `upload_skill` fails and its caller can retry.
  if (parsed.data.op === 'skill.write') {
    const { workspaceId, userId, skill, files } = parsed.data.input;
    if (!(await workspaceExists(deps.db, workspaceId))) return Response.json({ error: 'forbidden' }, { status: 403 });
    const written = await skillStore(d1SkillFileStore(deps.db)).write({ workspaceId, skill, userId, files });
    return Response.json(written satisfies SkillWriteOutput);
  }

  // The whole tree, because that is what the SDK's filesystem discovery needs rendered before
  // a turn begins (server/skills.ts materializes it).
  if (parsed.data.op === 'skill.list') {
    const { workspaceId } = parsed.data.input;
    if (!(await workspaceExists(deps.db, workspaceId))) return Response.json({ error: 'forbidden' }, { status: 403 });
    const files = await skillStore(d1SkillFileStore(deps.db)).tree(workspaceId);
    return Response.json({ files } satisfies SkillListOutput);
  }

  // Promote and adopt: the tier change itself, done at the edge so it is ONE operation on
  // the rows rather than a write and a delete the container sequences and can half-finish.
  if (parsed.data.op === 'component.promote' || parsed.data.op === 'component.adopt') {
    const { op } = parsed.data;
    const { workspaceId, canvasId, userId, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const store = componentStore(d1RecordStore(deps.db));
    try {
      const { rev } = await (op === 'component.promote' ? store.promote : store.adopt)({ workspaceId, canvasId, name, userId });
      return Response.json({ rev } satisfies ComponentWriteOutput);
    } catch (err) {
      // Caught, unlike a write — but only to carry the REASON back. These refusals are things
      // the agent must be able to read and act on ("a shared component of that name already
      // exists", "this canvas does not own that Component"), and the answer is still a
      // non-2xx, so the tool call fails exactly as loudly either way.
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  }

  // The data-file verbs. Same shape as the Component ones — the name and the size cap are in
  // the contract, so what is left here is ownership, then the write — plus the one rule the
  // contract cannot express: a `.json` that does not parse (the store checks it).
  if (parsed.data.op === 'data.write') {
    const { workspaceId, canvasId, userId, name, source } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    try {
      const { rev } = await dataStore(d1RecordStore(deps.db)).write({ workspaceId, canvasId, name, source, userId });
      return Response.json({ rev } satisfies DataWriteOutput);
    } catch (e) {
      // A content rule the caller can fix (unparseable JSON) is a 400 with the reason; a
      // store failure is NOT caught, so it reaches the container as a 5xx and fails the tool
      // call. Swallowing that is the 2026-07-29 shape.
      if (e instanceof Error && /not valid JSON/.test(e.message)) return Response.json({ error: e.message }, { status: 400 });
      throw e;
    }
  }

  if (parsed.data.op === 'data.read') {
    const { workspaceId, canvasId, name } = parsed.data.input;
    if (!(await canvasBelongsToWorkspace(deps.db, workspaceId, canvasId))) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }
    const source = await dataStore(d1RecordStore(deps.db)).read({ workspaceId, canvasId, name });
    return Response.json({ source } satisfies DataReadOutput);
  }

  return Response.json({ error: 'invalid request' }, { status: 400 });
}
