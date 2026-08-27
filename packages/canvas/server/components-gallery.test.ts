import { describe, expect, test } from 'bun:test';
import { leadingComment, listComponentDetails } from './components.ts';

describe('leadingComment', () => {
  test('joins a leading // block into one line, stops at code', () => {
    expect(leadingComment('// A bar chart.\n// No deps.\nexport default 1')).toBe('A bar chart. No deps.');
  });
  test('skips blank lines, handles block comments, empty when none', () => {
    expect(leadingComment('\n/* Block intro */\ncode')).toBe('Block intro');
    expect(leadingComment('export default 1')).toBe('');
  });
});

describe('listComponentDetails', () => {
  test('platform modules carry a description and the base tier', async () => {
    const md = (await listComponentDetails()).find((c) => c.name === 'MarkdownCard');
    expect(md?.tier).toBe('base');
    expect(md?.description).toContain('markdown card');
  });
});
