import { describe, expect, test } from 'bun:test';

import { padUrlFor } from './inbox-pad-url';

describe('padUrlFor', () => {
  test('builds the same-origin Render Pad URL for a linked canvas', () => {
    expect(padUrlFor({ workspaceId: 'acme', canvasId: 'c1' })).toBe('/w/acme/canvas/c1/pad');
  });

  test('encodes workspace and canvas ids', () => {
    expect(padUrlFor({ workspaceId: 'a b', canvasId: 'c/1' })).toBe('/w/a%20b/canvas/c%2F1/pad');
  });

  test('null canvasId → no linked canvas', () => {
    expect(padUrlFor({ workspaceId: 'acme', canvasId: null })).toBeNull();
  });
});
