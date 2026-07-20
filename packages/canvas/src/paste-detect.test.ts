import { describe, expect, test } from 'bun:test';
import { detectFromFile, detectPaste } from './paste-detect';

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

  test('emails and phone numbers count as data, so contact lists keep their header', () => {
    const d = detectPaste({ text: 'First Name,Last Name,Email,Phone\nJane,Doe,jdoe@example.com,555-0100\nJohn,Smith,jsmith@example.com,555-0199' });
    if (d?.kind !== 'table') throw new Error('expected a table');
    expect(d.columns).toEqual(['First Name', 'Last Name', 'Email', 'Phone']);
    expect(d.rows.length).toBe(2);
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

  test('an array of flat records is really a table', () => {
    const d = detectPaste({ text: '[{"name":"Acme","rev":100},{"name":"Globex","rev":200}]' });
    expect(d).toEqual({ kind: 'table', columns: ['name', 'rev'], rows: [['Acme', '100'], ['Globex', '200']] });
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

describe('detectPaste: mermaid / code / markdown', () => {
  test('raw mermaid source becomes a diagram', () => {
    expect(detectPaste({ text: 'flowchart TD\n  A --> B' })).toEqual({ kind: 'mermaid', chart: 'flowchart TD\n  A --> B' });
    expect(detectPaste({ text: 'sequenceDiagram\n  A->>B: hi' })?.kind).toBe('mermaid');
  });

  test('prose starting with the word graph is not mermaid', () => {
    expect(detectPaste({ text: 'graph theory is fun\nreally fun' })).toBeNull();
  });

  test('a single fenced block becomes a code card (mermaid fence → diagram)', () => {
    expect(detectPaste({ text: '```ts\nconst a = 1;\nconst b = 2;\n```' })).toEqual({ kind: 'code', code: 'const a = 1;\nconst b = 2;', lang: 'ts' });
    expect(detectPaste({ text: '```mermaid\nflowchart LR\n  A --> B\n```' })).toEqual({ kind: 'mermaid', chart: 'flowchart LR\n  A --> B' });
  });

  test('markdown with a heading or enough list lines becomes a markdown card', () => {
    expect(detectPaste({ text: '# Plan\n\nsome prose here' })).toEqual({ kind: 'markdown', md: '# Plan\n\nsome prose here' });
    expect(detectPaste({ text: 'todo\n- one\n- two\n- three' })?.kind).toBe('markdown');
  });

  test('short bullet-less prose stays plain text', () => {
    expect(detectPaste({ text: 'just a note\n- one item' })).toBeNull();
  });
});

describe('detectFromFile (drops)', () => {
  test('csv and tsv files become tables even below the paste thresholds', () => {
    expect(detectFromFile('data.csv', 'name,rev\nAcme,100')?.kind).toBe('table');
    expect(detectFromFile('data.tsv', 'a\tb\n1\t2')?.kind).toBe('table');
  });

  test('json files become json cards; invalid json falls back to a code card', () => {
    expect(detectFromFile('x.json', '{"a": 1}')).toEqual({ kind: 'json', value: { a: 1 } });
    expect(detectFromFile('x.json', '{oops')).toEqual({ kind: 'code', code: '{oops', lang: 'json' });
  });

  test('md and mmd files map by extension; unknown extensions stay with tldraw', () => {
    expect(detectFromFile('notes.md', 'plain prose, no markers')).toEqual({ kind: 'markdown', md: 'plain prose, no markers' });
    expect(detectFromFile('flow.mmd', 'flowchart LR\nA-->B')?.kind).toBe('mermaid');
    expect(detectFromFile('pic.png', 'binary-ish')).toBeNull();
  });
});
