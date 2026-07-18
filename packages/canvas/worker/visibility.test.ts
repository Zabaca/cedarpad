import { describe, expect, test } from 'bun:test';
import { canvasHiddenFrom, conversationHiddenFrom, mayFlipCanvas } from './visibility.ts';

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

describe('conversationHiddenFrom (ADR-0016 — canvas privacy dominates)', () => {
  const shared = { visibility: 'shared', createdBy: CREATOR } as const;
  test('shared chat on no/visible canvas hides from nobody', () => {
    expect(conversationHiddenFrom(shared, null, OTHER)).toBe(false);
    expect(conversationHiddenFrom(shared, { visibility: 'workspace', createdBy: OTHER }, OTHER)).toBe(false);
  });
  test('a private chat hides from non-creators, visible to its creator', () => {
    const priv = { visibility: 'private', createdBy: CREATOR } as const;
    expect(conversationHiddenFrom(priv, null, CREATOR)).toBe(false);
    expect(conversationHiddenFrom(priv, null, OTHER)).toBe(true);
  });
  test('canvas privacy dominates: the CHAT creator loses access when someone else\'s canvas goes private', () => {
    const canvas = { visibility: 'private', createdBy: OTHER } as const;
    expect(conversationHiddenFrom(shared, canvas, CREATOR)).toBe(true);
    expect(conversationHiddenFrom(shared, canvas, OTHER)).toBe(false);
  });
  test('a private chat on the canvas creator\'s private canvas stays hidden from the canvas creator', () => {
    const chat = { visibility: 'private', createdBy: CREATOR } as const;
    const canvas = { visibility: 'private', createdBy: OTHER } as const;
    expect(conversationHiddenFrom(chat, canvas, OTHER)).toBe(true);
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
