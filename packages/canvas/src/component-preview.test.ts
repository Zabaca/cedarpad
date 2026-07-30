import { describe, expect, test } from 'bun:test';

import { previewModule } from './component-preview';

describe('previewModule', () => {
  test('names the module to preview', () => {
    expect(previewModule('?preview=Roadmap')).toBe('Roadmap');
  });

  test('absent means this is an ordinary pad, not a preview', () => {
    expect(previewModule('')).toBeNull();
    expect(previewModule('?other=1')).toBeNull();
  });

  test('refuses anything that is not a bare module name', () => {
    // The value is interpolated into a module URL by the loader, so a name that can climb
    // out of the components directory is a path traversal. `normalizeShape` guards the
    // write side; this is the read side of the same rule.
    expect(previewModule('?preview=../secrets')).toBeNull();
    expect(previewModule('?preview=a/b')).toBeNull();
    expect(previewModule('?preview=')).toBeNull();
  });
});
