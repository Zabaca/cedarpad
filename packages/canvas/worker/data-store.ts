// Data-file policy over the Record port (ADR-0022) — the sibling of `component-store.ts`.
// A data file is the same kind of Record as a Component (same table, `kind: 'data'`), but
// what makes a data file VALID is a different set of rules: a closed, non-executable
// extension set, parseable JSON, and a size cap.
//
// This runs at the EDGE, deliberately: ADR-0022 says validation is enforced on the side that
// owns the rows, never trusted from the container's payload. It holds no SQL and no HTTP.

import { assertDataFileName, assertDataFileSource } from '../shared/bridge-wire.ts';
import type { RecordKey, RecordStore } from './record-store.ts';

/** A data file's coordinates — the name INCLUDES its extension (`sales.json`). */
export type DataFileKey = RecordKey;

export interface DataStore {
  /** Create or overwrite a data file. Throws on an invalid name, unparseable JSON, or a
   *  source over the cap — an author that cannot be persisted must FAIL, never lie. */
  write(input: DataFileKey & { source: string; userId: string | null }): Promise<{ rev: number }>;
  /** A data file's current content, or null when that tier holds none. */
  read(key: DataFileKey): Promise<string | null>;
}

export function dataStore(records: RecordStore): DataStore {
  return {
    write: async ({ source, userId, ...key }) => {
      assertDataFileName(key.name);
      assertDataFileSource(key.name, source);
      const row = await records.put({ ...key, kind: 'data', source, updatedBy: userId });
      return { rev: row.rev };
    },
    read: async (key) => {
      assertDataFileName(key.name);
      return (await records.get(key))?.source ?? null;
    },
  };
}
