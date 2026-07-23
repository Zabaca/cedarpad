import { describe, expect, test } from 'bun:test';

import { tocEntries } from './MarkdownCard.tsx';

describe('tocEntries', () => {
  test('multi-level doc: correct levels, texts, and block indexes', () => {
    const md = [
      '# Title',
      'some intro text',
      '## Section One',
      'body',
      '### Sub A',
      'more body',
      '## Section Two',
    ].join('\n');
    expect(tocEntries(md)).toEqual([
      { level: 1, text: 'Title', index: 0 },
      { level: 2, text: 'Section One', index: 2 },
      { level: 3, text: 'Sub A', index: 4 },
      { level: 2, text: 'Section Two', index: 6 },
    ]);
  });

  test('doc with no headings returns []', () => {
    const md = 'just a paragraph\nwith no headings at all';
    expect(tocEntries(md)).toEqual([]);
  });

  test('# lines inside a code fence are not headings', () => {
    const md = [
      '# Real Heading',
      '```',
      '# not a heading',
      '## also not a heading',
      '```',
      '## Another Real Heading',
    ].join('\n');
    expect(tocEntries(md)).toEqual([
      { level: 1, text: 'Real Heading', index: 0 },
      { level: 2, text: 'Another Real Heading', index: 2 },
    ]);
  });

  test('inline markdown in a heading passes through as raw heading text', () => {
    const md = '## The **plan**';
    expect(tocEntries(md)).toEqual([
      { level: 2, text: 'The **plan**', index: 0 },
    ]);
  });
});
