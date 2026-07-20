import { describe, expect, test } from 'bun:test';
import { detectedShapeSpec } from './paste-place';

describe('detectedShapeSpec', () => {
  test('a table maps to DataTable with size following its columns and rows', () => {
    const spec = detectedShapeSpec({ kind: 'table', columns: ['name', 'revenue'], rows: [['Acme', '100'], ['Globex', '200']] });
    expect(spec.module).toBe('DataTable');
    expect(spec.data.columns).toEqual(['name', 'revenue']);
    expect(spec.w).toBeGreaterThanOrEqual(320);
    expect(spec.w).toBeLessThanOrEqual(800);
    expect(spec.h).toBeGreaterThanOrEqual(140);
  });

  test('a huge table clamps to the max card size', () => {
    const rows = Array.from({ length: 5_000 }, (_, i) => [String(i), 'x'.repeat(60), 'y'.repeat(60), 'z'.repeat(60)]);
    const spec = detectedShapeSpec({ kind: 'table', columns: ['a', 'b', 'c', 'd'], rows });
    expect(spec.w).toBe(800);
    expect(spec.h).toBe(520);
  });

  test('markdown maps to MarkdownCard via its real prop name, `markdown`', () => {
    const spec = detectedShapeSpec({ kind: 'markdown', md: '# Hi' });
    expect(spec.module).toBe('MarkdownCard');
    expect(spec.data).toEqual({ markdown: '# Hi' });
  });

  test('json maps to JsonCard carrying the parsed value', () => {
    const spec = detectedShapeSpec({ kind: 'json', value: { a: 1 } });
    expect(spec.module).toBe('JsonCard');
    expect(spec.data).toEqual({ value: { a: 1 } });
  });
});
