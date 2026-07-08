import { describe, expect, test } from 'bun:test';

import { DEFAULT_CANVAS_ID, readCanvasCookie, withCanvasHeader, withCanvasParam } from './active-canvas';

// The client learns the active canvas from the NON-HttpOnly `cs_canvas` cookie the edge
// sets on `/w/:ws/canvas/:id`. Absent ⇒ `default` — behavior-preserving with today.
describe('readCanvasCookie — cookie ⇒ selected canvas, absent ⇒ null', () => {
  test('reads cs_canvas among other cookies', () => {
    expect(readCanvasCookie('cs_canvas=cv_1')).toBe('cv_1');
    expect(readCanvasCookie('cs_workspace=ws_a; cs_canvas=cv_2')).toBe('cv_2');
  });

  test('absent ⇒ null (caller defaults)', () => {
    expect(readCanvasCookie('cs_workspace=ws_a')).toBeNull();
    expect(readCanvasCookie('')).toBeNull();
    expect(readCanvasCookie(null)).toBeNull();
  });

  test('url-decodes the value', () => {
    expect(readCanvasCookie('cs_canvas=cv%5Fx')).toBe('cv_x');
  });
});

// activeCanvasId reads document.cookie; withCanvasHeader/withCanvasParam use it. In the
// bun test env there is no document, so activeCanvasId falls back to the default — which
// is exactly the "absent selection ⇒ default" contract we assert here.
describe('withCanvasHeader / withCanvasParam — stamp the selection (default when unset)', () => {
  test('header carries x-canvas-id and preserves existing headers', () => {
    const h = withCanvasHeader({ 'content-type': 'application/json' });
    expect(h['content-type']).toBe('application/json');
    expect(h['x-canvas-id']).toBe(DEFAULT_CANVAS_ID);
  });

  test('param appends ?canvas= / &canvas= correctly', () => {
    expect(withCanvasParam('/api/canvas/stream')).toBe(`/api/canvas/stream?canvas=${DEFAULT_CANVAS_ID}`);
    expect(withCanvasParam('/api/chat/stream?foo=1')).toBe(`/api/chat/stream?foo=1&canvas=${DEFAULT_CANVAS_ID}`);
  });
});
