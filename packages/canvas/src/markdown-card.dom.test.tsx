// MarkdownCard TOC behavior that has to hold INSIDE a component shape: entries must
// satisfy the shape's pointer guard (or tldraw eats the click as a drag), and a click
// must scroll the content div itself (scrollIntoView misbehaves under the canvas's
// CSS transforms). Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import MarkdownCard from './canvas-components/MarkdownCard';
import { isInteractiveControl } from './predicates';

const MD = '# One\n\nintro text\n\n## Two\n\nmore text';

const render = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return host;
};

/** Render the card and open the TOC rail (happy-dom hosts measure 0 wide, so the
 *  auto-open-on-wide effect never fires — open via the ☰ toggle, like a user would). */
const renderWithOpenToc = () => {
  const host = render(<MarkdownCard markdown={MD} />);
  const toggle = host.querySelector('button');
  expect(toggle).not.toBeNull();
  act(() => toggle!.click());
  return host;
};

describe('MarkdownCard TOC', () => {
  test('entries satisfy the shape pointer guard, so clicks reach the card not tldraw', () => {
    const host = renderWithOpenToc();
    const entries = host.querySelectorAll('[role="button"]');
    expect(entries.length).toBe(2);
    for (const entry of entries) expect(isInteractiveControl(entry)).toBe(true);
  });

  test('clicking an entry scrolls the content div to the heading offsetTop', () => {
    const host = renderWithOpenToc();
    const heading = host.querySelector('h2')!;
    Object.defineProperty(heading, 'offsetTop', { value: 300, configurable: true });
    const scrollDiv = heading.parentElement as HTMLElement & { scrollTo: (opts: unknown) => void };
    const calls: unknown[] = [];
    scrollDiv.scrollTo = (opts: unknown) => void calls.push(opts);
    const entries = host.querySelectorAll('[role="button"]');
    act(() => (entries[1] as HTMLElement).click());
    expect(calls).toEqual([{ top: 292, behavior: 'smooth' }]);
  });
});
