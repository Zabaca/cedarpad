// JsonCard behavior: a collapsible tree that renders lazily — collapsed subtrees
// and beyond-the-chunk array items stay OUT of the DOM, which is what keeps a huge
// pasted JSON cheap. Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import JsonCard from './canvas-components/JsonCard';

const render = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return host;
};

describe('JsonCard', () => {
  test('shows top-level keys and primitive values', () => {
    const host = render(<JsonCard value={{ name: 'Acme', active: true, count: 3 }} />);
    expect(host.textContent).toContain('name');
    expect(host.textContent).toContain('"Acme"');
    expect(host.textContent).toContain('true');
  });

  test('deep levels start collapsed and expand on click', () => {
    const host = render(<JsonCard value={{ a: { b: { secret: 'deep' } } }} />);
    expect(host.textContent).not.toContain('secret');
    const toggles = host.querySelectorAll('[data-toggle]');
    act(() => (toggles[toggles.length - 1] as HTMLElement).click()); // deepest visible collapsed node
    expect(host.textContent).toContain('secret');
  });

  test('big arrays render a first chunk plus a "more" control', () => {
    const value = Array.from({ length: 5_000 }, (_, i) => i);
    const host = render(<JsonCard value={value} />);
    expect(host.querySelectorAll('[data-json-entry]').length).toBeLessThan(200);
    expect(host.textContent).toContain('more');
  });

  test('non-JSON prop shapes do not crash (fresh gallery placement)', () => {
    const host = render(<JsonCard />);
    expect(host.textContent).toContain('undefined');
  });
});
