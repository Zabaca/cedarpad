import { describe, expect, test } from 'bun:test';

import { LEGACY_R2_PREFIX, LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import {
  DEFAULT_CANVAS_ID,
  DEFAULT_WORKSPACE_ID,
  decideCanvasRoute,
  decideWorkspaceRoute,
  parseCanvasRoute,
  parseWorkspaceRoute,
  readCanvasCookie,
  readWorkspaceCookie,
  selectInitialWorkspace,
} from './shell-routing.ts';

describe('parseWorkspaceRoute — /w/:workspaceId/…', () => {
  test('extracts the id, with or without an app-surface segment', () => {
    expect(parseWorkspaceRoute('/w/default')).toEqual({ workspaceId: 'default' });
    expect(parseWorkspaceRoute('/w/ws_abc123')).toEqual({ workspaceId: 'ws_abc123' });
    expect(parseWorkspaceRoute('/w/ws_abc123/canvas')).toEqual({ workspaceId: 'ws_abc123' });
    expect(parseWorkspaceRoute('/w/ws_abc123/src/main.tsx')).toEqual({ workspaceId: 'ws_abc123' });
  });

  test('non-/w paths and an empty id are not workspace routes', () => {
    expect(parseWorkspaceRoute('/')).toBeNull();
    expect(parseWorkspaceRoute('/w')).toBeNull();
    expect(parseWorkspaceRoute('/w/')).toBeNull();
    expect(parseWorkspaceRoute('/api/workspaces')).toBeNull();
  });
});

describe('parseCanvasRoute — /w/:ws/canvas/:id', () => {
  test('extracts both ids (with or without trailing slash)', () => {
    expect(parseCanvasRoute('/w/default/canvas/cv_1')).toEqual({ workspaceId: 'default', canvasId: 'cv_1' });
    expect(parseCanvasRoute('/w/ws_abc/canvas/cv_9/')).toEqual({ workspaceId: 'ws_abc', canvasId: 'cv_9' });
  });

  test('a bare workspace route or deeper asset path is NOT a canvas route', () => {
    expect(parseCanvasRoute('/w/ws_abc')).toBeNull();
    expect(parseCanvasRoute('/w/ws_abc/canvas')).toBeNull();
    expect(parseCanvasRoute('/w/ws_abc/canvas/')).toBeNull();
    expect(parseCanvasRoute('/w/ws_abc/canvas/cv_1/src/main.tsx')).toBeNull();
    expect(parseCanvasRoute('/')).toBeNull();
  });
});

describe('readCanvasCookie', () => {
  test('reads the canvas-selection cookie among others, else null', () => {
    expect(readCanvasCookie('cs_canvas=cv_1')).toBe('cv_1');
    expect(readCanvasCookie('cs_workspace=ws_a; cs_canvas=cv_2')).toBe('cv_2');
    expect(readCanvasCookie('cs_workspace=ws_a')).toBeNull();
    expect(readCanvasCookie(null)).toBeNull();
  });
});

describe('decideCanvasRoute — owned ws + canvas-in-ws ⇒ select, else 404 (never proxy)', () => {
  test("'default' workspace + a canvas that belongs to it ⇒ select both", () => {
    expect(decideCanvasRoute('default', 'cv_1', null, { workspaceId: 'default' })).toEqual({
      decision: 'select',
      workspaceId: 'default',
      canvasId: 'cv_1',
    });
    expect(DEFAULT_CANVAS_ID).toBe('default');
  });

  test('an owned workspace + a canvas in that workspace ⇒ select', () => {
    expect(decideCanvasRoute('ws_a', 'cv_1', { id: 'ws_a' }, { workspaceId: 'ws_a' })).toEqual({
      decision: 'select',
      workspaceId: 'ws_a',
      canvasId: 'cv_1',
    });
  });

  test('unknown/non-owned workspace ⇒ 404 even if the canvas exists', () => {
    expect(decideCanvasRoute('ws_a', 'cv_1', null, { workspaceId: 'ws_a' })).toEqual({ decision: 'not-found' });
  });

  test('unknown canvas ⇒ 404', () => {
    expect(decideCanvasRoute('ws_a', 'cv_x', { id: 'ws_a' }, null)).toEqual({ decision: 'not-found' });
  });

  test("the legacy 'default' canvas needs no row (switch-back), within a servable workspace", () => {
    expect(decideCanvasRoute('ws_a', 'default', { id: 'ws_a' }, null)).toEqual({
      decision: 'select',
      workspaceId: 'ws_a',
      canvasId: 'default',
    });
    // …but still 404 if the workspace itself isn't servable.
    expect(decideCanvasRoute('ws_a', 'default', null, null)).toEqual({ decision: 'not-found' });
  });

  test('canvas that belongs to a DIFFERENT workspace ⇒ 404 (never cross-workspace)', () => {
    expect(decideCanvasRoute('ws_a', 'cv_1', { id: 'ws_a' }, { workspaceId: 'ws_b' })).toEqual({
      decision: 'not-found',
    });
  });
});

describe('readWorkspaceCookie', () => {
  test('reads the selection cookie among others, else null', () => {
    expect(readWorkspaceCookie('cs_workspace=ws_abc')).toBe('ws_abc');
    expect(readWorkspaceCookie('foo=1; cs_workspace=default; bar=2')).toBe('default');
    expect(readWorkspaceCookie('foo=1; bar=2')).toBeNull();
    expect(readWorkspaceCookie(null)).toBeNull();
  });
});

describe('selectInitialWorkspace — default on first login', () => {
  test('empty list ⇒ the legacy default (behavior-preserving, no create)', () => {
    expect(selectInitialWorkspace([])).toBe(DEFAULT_WORKSPACE_ID);
    expect(DEFAULT_WORKSPACE_ID).toBe('default');
  });

  test('non-empty list ⇒ the first (oldest) existing workspace', () => {
    expect(selectInitialWorkspace([{ id: 'ws_1' }, { id: 'ws_2' }])).toBe('ws_1');
  });
});

describe('decideWorkspaceRoute — owned ⇒ serve, unknown ⇒ 404 (never proxy)', () => {
  test("'default' always serves the legacy workspace (no registry row)", () => {
    const d = decideWorkspaceRoute('default', null);
    expect(d.decision).toBe('serve');
    if (d.decision === 'serve') {
      // Legacy coords + CANVAS_WORKSPACE='default' — the prod container, unchanged.
      expect(resolve(d.workspace)).toEqual({
        sandboxId: LEGACY_SANDBOX_ID,
        r2Prefix: LEGACY_R2_PREFIX,
        canvasWorkspace: 'default',
      });
    }
  });

  test('an owned workspace serves its OWN derived coordinates', () => {
    const d = decideWorkspaceRoute('ws_abc123', { id: 'ws_abc123' });
    expect(d.decision).toBe('serve');
    if (d.decision === 'serve') {
      expect(resolve(d.workspace)).toEqual({
        sandboxId: 'workspace-ws_abc123',
        r2Prefix: 'workspaces/ws_abc123/',
        canvasWorkspace: 'ws_abc123',
      });
    }
  });

  test('an unknown / non-owned id (lookup null) ⇒ 404, never proxied', () => {
    expect(decideWorkspaceRoute('ws_nope', null)).toEqual({ decision: 'not-found' });
  });
});
