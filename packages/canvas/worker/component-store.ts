// Component policy over the Record port (ADR-0022). What a Component write MEANS — the
// name rule, the non-empty rule, which tier it lands in — lives here, above `RecordStore`
// and below the transport. It holds no SQL and no HTTP, so its rules are testable against
// the in-memory port with no database.
//
// This runs at the EDGE, deliberately: ADR-0022 says validation and tier rules are enforced
// on the side that owns the rows, never trusted from the container's payload.

import { COMPONENT_NAME_RE } from '../shared/bridge-wire.ts';
import type { RecordKey, RecordStore } from './record-store.ts';

/** A Component's coordinates. `canvasId: null` is the workspace shared tier. */
export type ComponentKey = RecordKey;

export interface ComponentStore {
  /** Create or overwrite an own- or shared-tier Component. Throws on an invalid name or
   *  an empty source — a Component write that cannot be persisted must FAIL, never lie. */
  write(input: ComponentKey & { source: string; userId: string | null }): Promise<{ rev: number }>;
  /** A Component's current source, or null when that tier holds none. */
  read(key: ComponentKey): Promise<string | null>;
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
  };
}
