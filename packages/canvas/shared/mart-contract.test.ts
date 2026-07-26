import { describe, expect, test } from 'bun:test';

import { coerceMartRow, MartName, MartSidecarSchema } from './mart-contract.ts';

describe('MartName — the boundary check before a name reaches a storage key (#238 review)', () => {
  test('accepts real mart names', () => {
    expect(MartName.safeParse('mart_session_events').success).toBe(true);
    expect(MartName.safeParse('mart_x').success).toBe(true);
  });

  test('rejects path-shaped or otherwise malformed names', () => {
    for (const bad of ['../etc/passwd', 'mart/x', 'mart.x', 'Mart_X', '', 'mart x', '..', '.']) {
      expect(MartName.safeParse(bad).success).toBe(false);
    }
  });
});

describe('coerceMartRow — the BigInt/JSON.stringify bug (ADR-0017 consequences)', () => {
  test('a raw bigint value does not survive JSON.stringify', () => {
    const raw = { input_tokens: 30n };
    expect(() => JSON.stringify(raw)).toThrow();
  });

  test('coerces an in-range bigint to a plain number that DOES JSON.stringify', () => {
    const row = coerceMartRow({ session_id: 'sess-aaa', input_tokens: 30n, is_error: false });
    expect(row.input_tokens).toBe(30);
    expect(typeof row.input_tokens).toBe('number');
    expect(() => JSON.stringify(row)).not.toThrow();
    expect(JSON.parse(JSON.stringify(row))).toEqual({ session_id: 'sess-aaa', input_tokens: 30, is_error: false });
  });

  test('falls back to a decimal string for a bigint outside safe-integer range', () => {
    const huge = 9_223_372_036_854_775_807n;
    const row = coerceMartRow({ big: huge });
    expect(row.big).toBe(huge.toString());
    expect(typeof row.big).toBe('string');
  });

  test('coerces a TIMESTAMP column arriving as a Date (a parquet reader like hyparquet, #238) to its ISO string, not a throw', () => {
    const row = coerceMartRow({ session_id: 'sess-aaa', ts: new Date('2026-07-20T10:00:05.000Z') });
    expect(row.ts).toBe('2026-07-20T10:00:05.000Z');
    expect(typeof row.ts).toBe('string');
    expect(() => JSON.stringify(row)).not.toThrow();
    expect(JSON.parse(JSON.stringify(row))).toEqual({ session_id: 'sess-aaa', ts: '2026-07-20T10:00:05.000Z' });
  });

  test('passes through plain string/number/boolean/null unchanged', () => {
    const row = coerceMartRow({ a: 'x', b: 1, c: true, d: null });
    expect(row).toEqual({ a: 'x', b: 1, c: true, d: null });
  });
});

describe('MartSidecarSchema — the declared schema is the deliverable', () => {
  test('accepts a well-formed sidecar', () => {
    const sidecar = {
      name: 'mart_session_events',
      description: 'test',
      columns: [{ name: 'session_id', type: 'VARCHAR' as const, description: 'id' }],
      generatedAt: new Date().toISOString(),
      rowCount: 3,
    };
    expect(MartSidecarSchema.parse(sidecar)).toEqual(sidecar);
  });

  test('rejects a sidecar with no declared columns', () => {
    expect(() =>
      MartSidecarSchema.parse({
        name: 'mart_x',
        description: 'test',
        columns: [],
        generatedAt: new Date().toISOString(),
        rowCount: 0,
      }),
    ).toThrow();
  });
});
