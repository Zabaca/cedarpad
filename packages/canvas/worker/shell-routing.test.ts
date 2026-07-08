import { describe, expect, test } from 'bun:test';

import { LEGACY_R2_PREFIX, LEGACY_SANDBOX_ID, resolve } from './sandbox-resolver.ts';
import {
  DEFAULT_WORKSPACE_ID,
  decideWorkspaceRoute,
  parseWorkspaceRoute,
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
