import { describe, expect, test } from 'bun:test';

import { buildShapeRecord, plaintextOf, UnbuildableShapeError } from './tl-record-builder';
import type { CanvasShape } from './shapes';

const rect: CanvasShape = { id: 'shape:r', type: 'rectangle', x: 1, y: 2, w: 30, h: 40, color: 'blue', text: 'hi' };

describe('buildShapeRecord', () => {
  test('builds a complete geo record from a rectangle intent', () => {
    const rec = buildShapeRecord(rect, undefined, 'page:page') as any;
    expect(rec.typeName).toBe('shape');
    expect(rec.type).toBe('geo');
    expect(rec.id).toBe('shape:r');
    expect(rec.parentId).toBe('page:page');
    expect(rec.props.geo).toBe('rectangle');
    expect(rec.props.w).toBe(30);
    expect(rec.props.color).toBe('blue');
    // The defaults the agent never supplies still have to be there — `put()` validates
    // the WHOLE record, so a missing `dash` is a rejected write.
    expect(rec.props.dash).toBe('draw');
    expect(plaintextOf(rec.props.richText)).toBe('hi');
  });

  test('an update merges onto the existing record, keeping props the agent never mentions', () => {
    const created = buildShapeRecord(rect, undefined, 'page:page') as any;
    const human = { ...created, index: 'a5', props: { ...created.props, font: 'serif', dash: 'dotted' } };
    const rec = buildShapeRecord({ ...rect, x: 99, text: 'bye' }, human, 'page:page') as any;
    expect(rec.x).toBe(99);
    expect(plaintextOf(rec.props.richText)).toBe('bye');
    // The human's styling and z-order survive an agent move — the agent's intent carries
    // neither, so overwriting them with defaults would be a silent data loss.
    expect(rec.props.font).toBe('serif');
    expect(rec.props.dash).toBe('dotted');
    expect(rec.index).toBe('a5');
  });

  test('refuses to author a freehand draw shape', () => {
    const draw: CanvasShape = { id: 'shape:d', type: 'draw', color: 'black', points: [[0, 0]] };
    expect(() => buildShapeRecord(draw, undefined, 'page:page')).toThrow(UnbuildableShapeError);
  });
});

// A note's text is rendered by tldraw at `(fontSizeAdjustment ?? 1) * labelFontSize`.
// `0 ?? 1` is 0 — nullish coalescing does not catch 0 — so a 0 here draws every note's
// text at 0px: present, correct, and invisible. That shipped in the 2026-07-28 cutover
// and hid the text on every migrated sticky note. It is not data loss, which is why the
// migration's `verify` (comparing the shape model) passed straight over it.
//
// Asserted as "renders at a visible size" rather than "== 1", so the same class of bug
// cannot return as a 0-equivalent.
describe('note defaults render text at a visible size', () => {
  const note: CanvasShape = { id: 'shape:n', type: 'note', x: 0, y: 0, color: 'yellow', text: 'hello' };
  const noteProps = () =>
    (buildShapeRecord(note, undefined, 'page:p') as unknown as { props: Record<string, unknown> }).props;

  test('a created note carries a non-zero fontSizeAdjustment multiplier', () => {
    expect(noteProps().fontSizeAdjustment).toBeGreaterThan(0);
  });

  test('and it keeps the text that would be rendered at that size', () => {
    expect(plaintextOf(noteProps().richText)).toBe('hello');
  });
});
