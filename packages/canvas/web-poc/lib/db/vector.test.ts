import { describe, expect, it } from "vitest";
import { problems } from "./schema.js";
import { vector32 } from "./vector.js";

// problems.embedding is a built float32Array column (F32_BLOB(1536)).
const col = problems.embedding;

describe("float32Array custom type", () => {
  it("declares an F32_BLOB column of the configured dimension", () => {
    expect(col.getSQLType()).toBe("F32_BLOB(1536)");
  });

  it("decodes a little-endian float32 buffer back to a number[]", () => {
    const source = new Float32Array([1.5, -2.25, 3.0]);
    const buf = new Uint8Array(source.buffer);
    const decoded = col.mapFromDriverValue(buf) as number[];
    expect(decoded).toEqual([1.5, -2.25, 3.0]);
  });

  it("decodes from an unaligned buffer slice", () => {
    const source = new Float32Array([7, 8]);
    const padded = new Uint8Array(source.byteLength + 1);
    padded.set(new Uint8Array(source.buffer), 1);
    const slice = padded.subarray(1); // byteOffset = 1, unaligned
    const decoded = col.mapFromDriverValue(slice) as number[];
    expect(decoded).toEqual([7, 8]);
  });
});

describe("vector32", () => {
  it("produces a vector32(...) SQL fragment", () => {
    const frag = vector32([1, 2, 3]);
    expect(frag.queryChunks.some((c) => JSON.stringify(c).includes("vector32"))).toBe(true);
  });
});
