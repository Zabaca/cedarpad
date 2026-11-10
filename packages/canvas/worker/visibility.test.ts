import { describe, expect, test } from 'bun:test';
import { canvasHiddenFrom, mayFlipCanvas } from './visibility.ts';

const CREATOR = 'u_creator';
const OTHER = 'u_other';

describe('canvasHiddenFrom (ADR-0016)', () => {
  test('workspace-visible hides from nobody', () => {
    expect(canvasHiddenFrom({ visibility: 'workspace', createdBy: CREATOR }, OTHER)).toBe(false);
    expect(canvasHiddenFrom({ visibility: 'workspace', createdBy: null }, OTHER)).toBe(false);
  });
  test('private hides from everyone but the creator — owner included (manage-not-read)', () => {
    expect(canvasHiddenFrom({ visibility: 'private', createdBy: CREATOR }, CREATOR)).toBe(false);
    expect(canvasHiddenFrom({ visibility: 'private', createdBy: CREATOR }, OTHER)).toBe(true);
  });
  test('a creator-less private row fails closed (hidden from everyone)', () => {
    expect(canvasHiddenFrom({ visibility: 'private', createdBy: null }, OTHER)).toBe(true);
  });
});

describe('mayFlipCanvas (creator both ways; owner force-publish only)', () => {
  const priv = { visibility: 'private', createdBy: CREATOR } as const;
  test('creator flips both directions', () => {
    expect(mayFlipCanvas(priv, CREATOR, false, 'workspace')).toBe(true);
    expect(mayFlipCanvas({ visibility: 'workspace', createdBy: CREATOR }, CREATOR, false, 'private')).toBe(true);
  });
  test('the owner may force-publish but never privatize someone else\'s canvas', () => {
    expect(mayFlipCanvas(priv, OTHER, true, 'workspace')).toBe(true);
    expect(mayFlipCanvas({ visibility: 'workspace', createdBy: CREATOR }, OTHER, true, 'private')).toBe(false);
  });
  test('a non-owner non-creator may flip nothing; creator-less canvases are unflippable', () => {
    expect(mayFlipCanvas(priv, OTHER, false, 'workspace')).toBe(false);
    expect(mayFlipCanvas({ visibility: 'workspace', createdBy: null }, OTHER, true, 'private')).toBe(false);
  });
});
