// The html-<table> branch needs DOMParser, so this file runs under the happy-dom
// harness (side-effect import MUST stay first — see happydom-harness.ts).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import { detectPaste } from './paste-detect';

const sheetsHtml = (rows: string) => `<meta charset="utf-8"><table><tbody>${rows}</tbody></table>`;

describe('detectPaste: html <table> (rich spreadsheet paste)', () => {
  test('a pasted spreadsheet table is detected from the html', () => {
    const d = detectPaste({
      text: 'name revenue Acme 100', // stripped html — structure lost
      html: sheetsHtml('<tr><td>name</td><td>revenue</td></tr><tr><td>Acme</td><td>100</td></tr>'),
    });
    expect(d).toEqual({ kind: 'table', columns: ['name', 'revenue'], rows: [['Acme', '100']] });
  });

  test('<th> cells force the header row even without numeric body cells', () => {
    const d = detectPaste({
      text: 'x',
      html: sheetsHtml('<tr><th>company</th><th>hq</th></tr><tr><td>Acme</td><td>NYC</td></tr><tr><td>Globex</td><td>LA</td></tr>'),
    });
    expect(d).toEqual({ kind: 'table', columns: ['company', 'hq'], rows: [['Acme', 'NYC'], ['Globex', 'LA']] });
  });

  test('html without a table falls through to the text detectors', () => {
    const d = detectPaste({ text: 'a\tb\nc\td', html: '<b>a b c d</b>' });
    expect(d?.kind).toBe('table');
    expect(detectPaste({ text: 'just words', html: '<b>just words</b>' })).toBeNull();
  });

  test('a one-row html table is not worth a component', () => {
    expect(detectPaste({ text: 'x', html: sheetsHtml('<tr><td>a</td><td>b</td></tr>') })).toBeNull();
  });
});
