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

/** A mart row as it crosses the boundary out of DuckDB. Values are the JS shapes a component
 * prop can hold — never `bigint` (ADR-0017 consequences: INT64 arrives as BigInt and does not
 * `JSON.stringify`; a mart row must already be past that by the time it reaches a caller). */
export type MartRow = Record<string, string | number | boolean | null>;

/** Coerce one raw row (as it might arrive from a BIGINT-producing reader) into a JSON-safe
 * MartRow: `bigint` → `number` when it's within Number.MAX_SAFE_INTEGER (every column this
 * pipeline emits — token counts, epoch millis — fits comfortably), else → its decimal string
 * so precision isn't silently lost. */
export function coerceMartRow(raw: Record<string, unknown>): MartRow {
  const out: MartRow = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'bigint') {
      out[key] =
        value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
    } else if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    } else {
      throw new Error(`coerceMartRow: unsupported value type for column "${key}": ${typeof value}`);
    }
  }
  return out;
}
