import { sql, type SQL } from "drizzle-orm";
import { customType } from "drizzle-orm/sqlite-core";

/**
 * libSQL/Turso native vector column.
 *
 * Stored as `F32_BLOB(dimensions)`. We serialize a JS `number[]` to the
 * `vector32(...)` SQL function on write, and decode the raw little-endian
 * float32 buffer back to `number[]` on read.
 *
 * Verified against Turso's Drizzle docs.
 */
export const float32Array = customType<{
  data: number[];
  config: { dimensions: number };
  configRequired: true;
  driverData: Buffer | Uint8Array;
}>({
  dataType(config) {
    return `F32_BLOB(${config.dimensions})`;
  },
  fromDriver(value) {
    const buf =
      value instanceof Uint8Array ? value : new Uint8Array(value as ArrayLike<number>);
    // Copy into a tightly-aligned buffer before viewing as Float32Array.
    const aligned = new Uint8Array(buf.byteLength);
    aligned.set(buf);
    return Array.from(new Float32Array(aligned.buffer));
  },
  toDriver(value: number[]): SQL {
    return sql`vector32(${JSON.stringify(value)})`;
  },
});

/** A `vector32('[...]')` SQL literal for raw queries (e.g. vector_top_k args). */
export function vector32(value: number[]): SQL {
  return sql`vector32(${JSON.stringify(value)})`;
}

/**
 * Cosine *similarity* (1 - distance) between a stored column and a query vector,
 * as an orderable/selectable SQL fragment. Higher = more similar.
 */
export function cosineSimilarity(column: SQL.Aliased | SQL | unknown, query: number[]): SQL<number> {
  return sql<number>`1 - vector_distance_cos(${column}, ${vector32(query)})`;
}
