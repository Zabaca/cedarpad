import { describe, expect, test } from 'bun:test';
import { detectPaste } from './paste-detect';

describe('detectPaste: TSV (spreadsheet copy)', () => {
  test('a rectangular tab-separated block becomes a table', () => {
    const d = detectPaste({ text: 'name\trevenue\nAcme\t100\nGlobex\t200' });
    expect(d).toEqual({ kind: 'table', columns: ['name', 'revenue'], rows: [['Acme', '100'], ['Globex', '200']] });
  });

  test('a single line is not a table', () => {
    expect(detectPaste({ text: 'a\tb\tc' })).toBeNull();
  });

  test('plain prose is not a table', () => {
    expect(detectPaste({ text: 'hello world\nthis is just text' })).toBeNull();
  });

  test('ragged tab counts (tab-indented code) are not a table', () => {
    expect(detectPaste({ text: 'function x() {\n\treturn 1;\n}' })).toBeNull();
  });

  test('uniformly tab-indented code (empty first column) is not a table', () => {
    expect(detectPaste({ text: '\tfoo();\n\tbar();' })).toBeNull();
  });

  test('all-text rows get synthesized A/B/C column letters (no header row consumed)', () => {
    const d = detectPaste({ text: 'Acme\tWest\nGlobex\tEast' });
    expect(d).toEqual({ kind: 'table', columns: ['A', 'B'], rows: [['Acme', 'West'], ['Globex', 'East']] });
  });

  test('quoted cells keep embedded newlines and tabs (Sheets multiline cells)', () => {
    const d = detectPaste({ text: 'name\tnote\nAcme\t"line one\nline two"\nGlobex\t42' });
    expect(d).toEqual({
      kind: 'table',
      columns: ['name', 'note'],
      rows: [['Acme', 'line one\nline two'], ['Globex', '42']],
    });
  });

  test('a huge paste is truncated and reports the true row count', () => {
    const text = ['id\tvalue', ...Array.from({ length: 30_000 }, (_, i) => `${i}\t${i * 2}`)].join('\n');
    const d = detectPaste({ text });
    if (d?.kind !== 'table') throw new Error('expected a table');
    expect(d.rows.length).toBe(10_000); // 20k cell cap / 2 columns
    expect(d.totalRows).toBe(30_000);
  });

  test('the raw plain-text source wins over stripped html text', () => {
    const d = detectPaste({
      text: 'name revenue Acme 100 Globex 200', // what stripHtml makes of a table
      html: '<b>whatever</b>',
      sources: [{ type: 'text', subtype: 'text', data: 'name\trevenue\nAcme\t100\nGlobex\t200' }],
    });
    expect(d?.kind).toBe('table');
  });
});

describe('detectPaste: CSV', () => {
  test('three consistent comma rows become a table', () => {
    const d = detectPaste({ text: 'name,revenue\nAcme,100\nGlobex,200' });
    expect(d).toEqual({ kind: 'table', columns: ['name', 'revenue'], rows: [['Acme', '100'], ['Globex', '200']] });
  });

  test('two lines of comma-ed prose are not a table (CSV needs 3+ rows)', () => {
    expect(detectPaste({ text: 'I like apples, oranges\nAlso pears, plums' })).toBeNull();
  });

  test('prose with inconsistent commas is not a table', () => {
    expect(detectPaste({ text: 'First, we ship it.\nThen we see, measure, and learn.\nFinally, we iterate.' })).toBeNull();
  });

  test('quoted CSV fields may contain commas', () => {
    const d = detectPaste({ text: 'company,revenue\n"Acme, Inc.",100\nGlobex,200' });
    if (d?.kind !== 'table') throw new Error('expected a table');
    expect(d.rows[0]).toEqual(['Acme, Inc.', '100']);
  });
});

describe('detectPaste: JSON', () => {
  test('a JSON object becomes a json card', () => {
    expect(detectPaste({ text: '{"a": 1, "b": [2, 3]}' })).toEqual({ kind: 'json', value: { a: 1, b: [2, 3] } });
  });

  test('a JSON array becomes a json card', () => {
    expect(detectPaste({ text: '[1, 2, 3]' })).toEqual({ kind: 'json', value: [1, 2, 3] });
  });

  test('bare numbers and quoted strings stay plain text', () => {
    expect(detectPaste({ text: '42' })).toBeNull();
    expect(detectPaste({ text: '"hello"' })).toBeNull();
  });

  test('almost-JSON stays plain text', () => {
    expect(detectPaste({ text: '{not: valid json}' })).toBeNull();
  });

  test('a subtype-json clipboard source is detected even when text is html-stripped', () => {
    const d = detectPaste({
      text: 'a 1',
      html: '<span>{"a": 1}</span>',
      sources: [{ type: 'text', subtype: 'json', data: '{"a": 1}' }],
    });
    expect(d).toEqual({ kind: 'json', value: { a: 1 } });
  });
});
