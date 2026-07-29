import { describe, expect, it } from 'bun:test';

import type { CanvasShape } from './shapes';
import { resolveReplyTarget } from './reply-target';

// Minimal fixture builders — only the fields resolveReplyTarget reads.
const chat = (id: string, chatId?: string): CanvasShape =>
  ({ type: 'chat', id, color: 'grey', x: 0, y: 0, w: 380, h: 460, title: '', ...(chatId ? { chatId } : {}) }) as CanvasShape;
const component = (id: string): CanvasShape =>
  ({ type: 'component', id, color: 'grey', x: 0, y: 0, w: 360, h: 260, module: 'PlanMode', data: {}, rev: 1 }) as CanvasShape;
const arrow = (id: string, startShapeId: string, endShapeId: string): CanvasShape =>
  ({ type: 'arrow', id, color: 'grey', x1: 0, y1: 0, x2: 0, y2: 0, text: '', startShapeId, endShapeId }) as CanvasShape;

describe('resolveReplyTarget', () => {
  it("returns the linked chat's session id, even when a different chat is focused", () => {
    // Component made by chat A (arrow A -> component), but the user last clicked chat B.
    const shapes = [
      chat('shape:chatA'),
      chat('shape:chatB'),
      component('shape:comp1'),
      arrow('shape:arr1', 'shape:chatA', 'shape:comp1'),
    ];
    expect(resolveReplyTarget(shapes, 'shape:comp1', 'shape:chatB')).toBe('shape:chatA');
  });

  it('returns null when the focused id names no existing chat (never a dead POST target)', () => {
    // An unlinked component and a stale focus id (e.g. the old 'chat_1' default, or a
    // since-deleted chat). Must NOT hand back the dead id.
    const shapes = [component('shape:comp1'), chat('shape:chatB')];
    expect(resolveReplyTarget(shapes, 'shape:comp1', 'chat_1')).toBeNull();
  });

  it('falls back to the focused chat for an unlinked (palette-placed) component', () => {
    const shapes = [component('shape:comp1'), chat('shape:chatB')];
    expect(resolveReplyTarget(shapes, 'shape:comp1', 'shape:chatB')).toBe('shape:chatB');
  });

  it("resolves an attach-flow chat to its session id (chatId), not its shape id", () => {
    // A chat card fronting an Inbox conversation: props.chatId is the session; shape id differs.
    const shapes = [
      chat('shape:cardX', 'conv_abc'),
      component('shape:comp1'),
      arrow('shape:arr1', 'shape:cardX', 'shape:comp1'),
    ];
    expect(resolveReplyTarget(shapes, 'shape:comp1', undefined)).toBe('conv_abc');
  });

  it('returns null when there is no link and no focused chat', () => {
    const shapes = [component('shape:comp1'), chat('shape:chatB')];
    expect(resolveReplyTarget(shapes, 'shape:comp1', undefined)).toBeNull();
  });

  it('falls back when the linked chat was deleted (dangling arrow)', () => {
    // Arrow still points at a chat shape that is gone; fall through to the focused chat.
    const shapes = [
      component('shape:comp1'),
      chat('shape:chatB'),
      arrow('shape:arr1', 'shape:goneChat', 'shape:comp1'),
    ];
    expect(resolveReplyTarget(shapes, 'shape:comp1', 'shape:chatB')).toBe('shape:chatB');
  });
});
