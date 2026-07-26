// The mart contract (ADR-0017 / CLAUDE.md §7): a mart is not a mart without its declared
// column schema + freshness — never inferred. This is the single zod-defined shape both the
// materialize pipeline (writer) and any future mart reader (edge Worker, #238) import and
// parse at the boundary, so the two sides can't drift.

import { z } from 'zod';

/** DuckDB/Parquet physical types this pipeline emits. Narrower than DuckDB's full type
 * vocabulary on purpose — only what a mart column actually needs (CLAUDE.md §2). */
export const MartColumnTypeSchema = z.enum(['VARCHAR', 'TIMESTAMP', 'BIGINT', 'DOUBLE', 'BOOLEAN']);
export type MartColumnType = z.infer<typeof MartColumnTypeSchema>;

export const MartColumnSchema = z.object({
  name: z.string(),
  type: MartColumnTypeSchema,
  description: z.string(),
});
export type MartColumn = z.infer<typeof MartColumnSchema>;

/** The sidecar written next to a mart's parquet file at `<mart>.schema.json`. `generatedAt`
 * is the mart's freshness stamp — the time THIS materialize run produced the parquet, not an
 * inferred file mtime (a component reads this to show "as of"). */
export const MartSidecarSchema = z.object({
  name: z.string(),
  description: z.string(),
  columns: z.array(MartColumnSchema).min(1),
  generatedAt: z.string().datetime(),
  rowCount: z.number().int().nonnegative(),
});
export type MartSidecar = z.infer<typeof MartSidecarSchema>;

/** How a component instance names the mart it renders (ADR-0017: "a component names a
 * mart, not a URL" — closes #219's arbitrary-fetch question, since the mart namespace IS
 * the boundary). Minimal on purpose: THIS slice (#238) only declares the field + shape so
 * the guest-scoping resolver (`martsReferencedBy`) has something to read; placement and
 * rendering are #239's job, not this one's. */
export const DataSourceSchema = z.object({
  kind: z.literal('mart'),
  name: z.string(),
});
export type DataSource = z.infer<typeof DataSourceSchema>;

/** A mart row as it crosses the boundary out of DuckDB. Values are the JS shapes a component
 * prop can hold — never `bigint` (ADR-0017 consequences: INT64 arrives as BigInt and does not
 * `JSON.stringify`; a mart row must already be past that by the time it reaches a caller), and
 * never a raw `Date` (a parquet reader — e.g. #238's `hyparquet` in the edge Worker — returns
 * TIMESTAMP/DATE columns as JS `Date` objects; `coerceMartRow` flattens those to ISO strings). */
export type MartRow = Record<string, string | number | boolean | null>;

/** Coerce one raw row (as it might arrive from a BIGINT- and Date-producing reader) into a
 * JSON-safe MartRow: `bigint` → `number` when it's within Number.MAX_SAFE_INTEGER (every
 * numeric column this pipeline emits — token counts, epoch millis — fits comfortably), else →
 * its decimal string so precision isn't silently lost; `Date` (a TIMESTAMP/DATE column) →
 * `toISOString()`, since the sidecar already declares the column's semantic type and a
 * component wants a string, not a further conversion step. */
export function coerceMartRow(raw: Record<string, unknown>): MartRow {
  const out: MartRow = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'bigint') {
      out[key] =
        value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
    } else if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new Error(`coerceMartRow: unsupported value type for column "${key}": ${typeof value}`);
    }
  }
  return out;
}
