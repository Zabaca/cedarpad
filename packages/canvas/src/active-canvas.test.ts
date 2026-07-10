// Registers happy-dom globals first: activeCanvasId reads window.location, and the
// stale-cookie test needs a document.cookie to prove it is NOT consulted.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';

import { DEFAULT_CANVAS_ID, activeCanvasId, canvasIdFromPath, withCanvasHeader, withCanvasParam, withPadCanvasHeader } from './active-canvas';

const setPath = (pathname: string) => {
  (globalThis as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(
    `https://poc.cedarpad.com${pathname}`,
  );
};

afterEach(() => setPath('/'));

// The client learns the active canvas from its OWN URL — the Render Pad is served at
// `/w/:ws/canvas/:id/pad` (#105), so the iframe is self-describing and two tabs can hold
// two canvases. Absent selection ⇒ `default` — behavior-preserving with today.
describe('canvasIdFromPath — the pad URL carries the selection', () => {
  test('extracts the canvas id from a pad path', () => {
    expect(canvasIdFromPath('/w/abc/canvas/xyz/pad')).toBe('xyz');
    expect(canvasIdFromPath('/w/default/canvas/cv_1/pad')).toBe('cv_1');
  });

  test('any non-pad path ⇒ null (caller defaults)', () => {
    expect(canvasIdFromPath('/')).toBeNull();
    expect(canvasIdFromPath('/w/abc/canvas/xyz')).toBeNull();
    expect(canvasIdFromPath('/w/abc')).toBeNull();
  });
});

describe('activeCanvasId — reads the pad URL, never a cookie', () => {
  test('/w/abc/canvas/xyz/pad ⇒ xyz', () => {
    setPath('/w/abc/canvas/xyz/pad');
    expect(activeCanvasId()).toBe('xyz');
  });

  test('/ ⇒ default', () => {
    setPath('/');
    expect(activeCanvasId()).toBe(DEFAULT_CANVAS_ID);
  });

  test('a stale cs_canvas cookie is ignored — the URL is the sole source', () => {
    document.cookie = 'cs_canvas=stale_cv';
    setPath('/');
    expect(activeCanvasId()).toBe(DEFAULT_CANVAS_ID);
    setPath('/w/abc/canvas/xyz/pad');
    expect(activeCanvasId()).toBe('xyz');
  });
});

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

// Chat calls claim a canvas only when the surface IS a pad: the chat-store is shared with
// non-pad surfaces (the Inbox thread), where a defaulted x-canvas-id would falsely link the
// conversation to the Default canvas (the chat→canvas edge is a claim, not a fallback).
describe('withPadCanvasHeader — stamp only on a pad URL', () => {
  test('on a pad: stamps that canvas id', () => {
    setPath('/w/abc/canvas/cv_7/pad');
    const h = withPadCanvasHeader({ 'content-type': 'application/json' });
    expect(h['x-canvas-id']).toBe('cv_7');
    expect(h['content-type']).toBe('application/json');
  });

  test('off a pad (inbox, shell): NO x-canvas-id — not even default', () => {
    setPath('/');
    const h = withPadCanvasHeader({ 'content-type': 'application/json' });
    expect(h['x-canvas-id']).toBeUndefined();
    expect(h['content-type']).toBe('application/json');
  });
});
