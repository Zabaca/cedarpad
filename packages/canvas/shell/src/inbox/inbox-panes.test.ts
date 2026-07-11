import { describe, expect, test } from 'bun:test';
import { clampWidth, DEFAULT_PANE_WIDTHS, parseCanvasHidden, parsePaneWidths, serializePaneWidths } from './inbox-panes';

// Column management (drag-to-resize + canvas-pane toggle): the pure width-clamping and
// localStorage-serialization logic, kept free of any DOM/pointer-event handling so it unit-tests
// without jsdom (the drag interaction itself is exercised only lightly, in Inbox.test.tsx).

describe('clampWidth', () => {
  test('passes a width through when it is within [min, max]', () => {
    expect(clampWidth(300, 200, 600)).toBe(300);
  });
  test('floors at min', () => {
    expect(clampWidth(50, 200, 600)).toBe(200);
  });
  test('ceils at max', () => {
    expect(clampWidth(9000, 200, 600)).toBe(600);
  });
});

describe('parsePaneWidths / serializePaneWidths', () => {
  test('round-trips a valid widths object', () => {
    const widths = { list: 300, thread: 500 };
    expect(parsePaneWidths(serializePaneWidths(widths))).toEqual(widths);
  });

  test('null/garbage/partial JSON falls back to the defaults', () => {
    expect(parsePaneWidths(null)).toEqual(DEFAULT_PANE_WIDTHS);
    expect(parsePaneWidths('not json')).toEqual(DEFAULT_PANE_WIDTHS);
    expect(parsePaneWidths('{"list":300}')).toEqual(DEFAULT_PANE_WIDTHS);
    expect(parsePaneWidths('{"list":"x","thread":500}')).toEqual(DEFAULT_PANE_WIDTHS);
  });
});

describe('parseCanvasHidden', () => {
  test('"true" is hidden, everything else (including null) is shown', () => {
    expect(parseCanvasHidden('true')).toBe(true);
    expect(parseCanvasHidden('false')).toBe(false);
    expect(parseCanvasHidden(null)).toBe(false);
    expect(parseCanvasHidden('garbage')).toBe(false);
  });
});
