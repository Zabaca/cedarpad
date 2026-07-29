// Component policy over the Record port (ADR-0022). What a Component write MEANS — the
// name rule, the non-empty rule, which tier it lands in — lives here, above `RecordStore`
// and below the transport. It holds no SQL and no HTTP, so its rules are testable against
// the in-memory port with no database.
//
// This runs at the EDGE, deliberately: ADR-0022 says validation and tier rules are enforced
// on the side that owns the rows, never trusted from the container's payload.

import { COMPONENT_NAME_RE } from '../shared/bridge-wire.ts';
import type { ComponentVersion } from '../shared/platform-rpc.ts';
import type { RecordKey, RecordStore } from './record-store.ts';

/** A Component's coordinates. `canvasId: null` is the workspace shared tier. */
export type ComponentKey = RecordKey;

/** Promote and adopt always name a real canvas — one end of the move is its own library. */
export type TierMove = { workspaceId: string; canvasId: string; name: string; userId: string | null };

export interface ComponentStore {
  /** Create or overwrite an own- or shared-tier Component. Throws on an invalid name or
   *  an empty source — a Component write that cannot be persisted must FAIL, never lie. */
  write(input: ComponentKey & { source: string; userId: string | null }): Promise<{ rev: number }>;
  /** A Component's current source, or null when that tier holds none. */
  read(key: ComponentKey): Promise<string | null>;
  /** Every version of a Component, newest first; empty when it has none. Answers for a
   *  soft-deleted Component too — history is what a deletion must not be able to destroy.
   *  Deliberately WITHOUT the source: "what happened to this" must not cost every revision
   *  of the text, and a restore (#362) names a version rather than carrying one. */
  history(key: ComponentKey): Promise<ComponentVersion[]>;
  /** Move a canvas's Component into the workspace shared library: ONE change of tier, so
   *  the Component is never in both libraries and never in neither. */
  promote(input: TierMove): Promise<{ rev: number }>;
  /** Copy a shared Component into a canvas's own library so that canvas can diverge from
   *  it deliberately. The shared source is untouched — this is a copy, not a move. */
  adopt(input: TierMove): Promise<{ rev: number }>;
}

/** The same message the filesystem module has always thrown, so the agent-facing tool
 *  error text does not change with the storage migration. */
export function assertComponentName(name: string): void {
  if (!COMPONENT_NAME_RE.test(name)) {
    throw new Error(`invalid component name "${name}" — use letters/digits/_/- and no extension`);
  }
}

export function componentStore(records: RecordStore): ComponentStore {
  return {
    write: async ({ source, userId, ...key }) => {
      assertComponentName(key.name);
      if (typeof source !== 'string' || source.trim().length === 0) throw new Error('source must be non-empty');
      const row = await records.put({ ...key, kind: 'component', source, updatedBy: userId });
      return { rev: row.rev };
    },
    read: async (key) => {
      assertComponentName(key.name);
      return (await records.get(key))?.source ?? null;
    },
    history: async (key) => {
      assertComponentName(key.name);
      return (await records.listVersions(key)).map(({ version, createdAt, createdBy }) => ({ version, createdAt, createdBy }));
    },
    promote: async ({ workspaceId, canvasId, name, userId }) => {
      assertComponentName(name);
      const own = { workspaceId, canvasId, name };
      const shared = { workspaceId, canvasId: null, name };
      if (!(await records.get(own))) throw new Error(`component "${name}" is not in canvas "${canvasId}" to promote`);
      if (await records.get(shared)) throw new Error(`a shared component "${name}" already exists`);
      // The move is one operation on purpose (see `RecordStore.move`). The rev returned is
      // the one the store assigned, so "promoted" can only be said of a write that landed —
      // the reported incident was a promote that announced success it had not earned.
      return { rev: (await records.move(own, shared, userId)).rev };
    },
    adopt: async ({ workspaceId, canvasId, name, userId }) => {
      assertComponentName(name);
      const source = (await records.get({ workspaceId, canvasId: null, name }))?.source;
      if (source === undefined) throw new Error(`no shared component "${name}" to copy`);
      const row = await records.put({ workspaceId, canvasId, name, kind: 'component', source, updatedBy: userId });
      return { rev: row.rev };
    },
  };
}
