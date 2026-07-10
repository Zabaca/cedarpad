import { describe, expect, test } from 'bun:test';

import { canvasFromUrl, urlWithCanvas } from './canvas-url';

// The canvas stage's selection is a URL, not just component state: reloading
// `/?canvas=cv_1` must reopen that canvas. Mirrors stage.ts / inbox-url.ts.
describe('canvas ↔ URL', () => {
  test('bare `/` names no canvas', () => {
    expect(canvasFromUrl('')).toBeNull();
    expect(canvasFromUrl('?')).toBeNull();
  });

  test('`?canvas=<id>` names that canvas', () => {
    expect(canvasFromUrl('?canvas=cv_1')).toBe('cv_1');
  });

  test('a selected canvas round-trips through its URL', () => {
    expect(canvasFromUrl(urlWithCanvas('', 'cv_1'))).toBe('cv_1');
  });

  test('no selection is the clean URL, not `?canvas=`', () => {
    expect(urlWithCanvas('', null)).toBe('');
  });

  test('deselecting removes `canvas` from the URL', () => {
    expect(urlWithCanvas('?canvas=cv_1', null)).toBe('');
  });

  test('other params (e.g. `stage`) pass through untouched', () => {
    expect(urlWithCanvas('?stage=canvas', 'cv_1')).toBe('?stage=canvas&canvas=cv_1');
    expect(canvasFromUrl('?stage=canvas&canvas=cv_1')).toBe('cv_1');
  });
});
