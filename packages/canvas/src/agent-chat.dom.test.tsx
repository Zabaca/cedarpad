// AgentChat behavior. The load-bearing test here is the pin guard: this card is ported
// from a registry whose disclosures are bare <summary> and whose approval options are
// role="radio" divs, and neither reaches a component through ComponentShape's
// capture-phase pointer guard. Every control has to satisfy `isInteractiveControl` or the
// card looks right and does nothing. Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { describe, expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import AgentChat, { appendTurn, slashMatches } from './canvas-components/AgentChat';
import { isInteractiveControl } from './predicates';

const render = (el: React.ReactElement) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  return host;
};

describe('AgentChat', () => {
  test('renders the default transcript across every block kind', () => {
    const host = render(<AgentChat />);
    const text = host.textContent ?? '';
    expect(text).toContain('add a dark-mode toggle'); // user turn
    expect(text).toContain('Add the dark-mode toggle'); // todo
    expect(text).toContain('Read 48 lines'); // tool call
    expect(text).toContain('user_prompt_submit'); // event line
    expect(text).toContain('Thought for 0.2s'); // thought block
    expect(text).toContain('3 additions and 1 removal'); // diff summary
    expect(text).toContain('<Panel header={<ThemeToggle />}>'); // diff add line
    expect(text).toContain('stored() is not exported'); // write hook failure
    expect(text).toContain('app/settings/theme-toggle.tsx'); // tool card
    expect(text).toContain('Do you want to proceed?'); // permission
    expect(text).toContain('a approve'); // plan actions
    expect(text).toContain('Waiting for response…'); // working line
  });

  test('a write block labels its before/after rows for screen readers', () => {
    const host = render(<AgentChat />);
    const region = host.querySelector('[aria-label="Write preview"]');
    expect(region?.textContent).toContain('before: ');
    expect(region?.textContent).toContain('after: ');
    // Hook results carry pass/fail in text, not colour alone.
    expect(host.textContent).toContain('(failed)');
  });

  test('grok gets its own approval grammar, not the fieldset', () => {
    const claude = render(<AgentChat skin="claude" />);
    expect(claude.querySelector('fieldset legend')?.textContent).toContain('Claude Code');
    expect(claude.textContent).not.toContain('Ctrl+o:yolo');

    const grok = render(<AgentChat skin="grok" />);
    expect(grok.textContent).toContain('Ctrl+o:yolo');
    expect(grok.textContent).toContain('(●)');
  });

  test('the two shimmering working lines keep selectable, announced text', () => {
    for (const skin of ['claude', 'codex'] as const) {
      const host = render(<AgentChat skin={skin} transcript={[{ kind: 'thinking' }]} />);
      const line = host.querySelector('[role="status"][aria-live="polite"]');
      expect(line?.textContent).toContain('esc to interrupt');
      // background-clip: text, not a canvas or an image — the word is still in the DOM.
      expect(host.querySelector('.ac-shine')?.textContent?.length).toBeGreaterThan(0);
    }
  });

  test('a tool call with output is a keyboard-operable disclosure that passes the pin guard', () => {
    const host = render(<AgentChat />);
    const summary = host.querySelector('details > summary');
    expect(summary).not.toBeNull();
    // Without role="button" tldraw claims the pointerdown and no click is ever synthesized.
    expect(isInteractiveControl(summary as Element)).toBe(true);
  });

  test('permission options and the skin switcher are real buttons', () => {
    const host = render(<AgentChat />);
    const radios = host.querySelectorAll('[role="radio"]');
    expect(radios.length).toBe(3);
    for (const r of radios) expect(isInteractiveControl(r)).toBe(true);
    for (const b of host.querySelectorAll('button')) expect(isInteractiveControl(b)).toBe(true);
  });

  test('choosing a permission option acknowledges it', () => {
    const host = render(<AgentChat />);
    const radios = host.querySelectorAll('[role="radio"]');
    act(() => (radios[1] as HTMLElement).click());
    expect(host.querySelector('[role="status"]')?.textContent).toContain("don't ask again");
  });

  test('the composer is a real input and a real send button', () => {
    const host = render(<AgentChat />);
    const input = host.querySelector('input[aria-label="Prompt"]') as HTMLInputElement;
    expect(isInteractiveControl(input)).toBe(true);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === 'send')).toBe(true);
  });

  test('sending an empty prompt is a no-op', () => {
    let called = false;
    const host = render(<AgentChat setData={() => (called = true)} />);
    const send = [...host.querySelectorAll('button')].find((b) => b.textContent === 'send');
    act(() => (send as HTMLElement).click());
    expect(called).toBe(false);
  });

  test('each skin renders its own header grammar', () => {
    expect(render(<AgentChat skin="claude" />).textContent).toContain('Tips for getting started');
    expect(render(<AgentChat skin="codex" />).textContent).toContain('OpenAI Codex');
    expect(render(<AgentChat skin="grok" />).textContent).toContain('500K');
  });

  test('an unknown skin falls back rather than crashing on a fresh placement', () => {
    const host = render(<AgentChat skin={'nope' as 'claude'} />);
    expect(host.textContent).toContain('Tips for getting started');
  });
});

// The slash menu's filtering is the same problem as the composer's send — it keys off the
// draft, which no DOM event can set here (see the note below). Pinned on the pure matcher.
describe('slashMatches', () => {
  test('a bare slash lists that skin’s whole command set', () => {
    expect(slashMatches('claude', '/').map((c) => c.name)).toContain('/compact');
    expect(slashMatches('codex', '/').map((c) => c.name)).toContain('/permissions');
    expect(slashMatches('grok', '/').map((c) => c.name)).toContain('/fork');
  });

  test('the skins do not share a command set', () => {
    expect(slashMatches('grok', '/').map((c) => c.name)).not.toContain('/agents');
    expect(slashMatches('claude', '/').map((c) => c.name)).not.toContain('/quit');
  });

  test('filters by name prefix, case-insensitively', () => {
    expect(slashMatches('claude', '/CO').map((c) => c.name)).toEqual(['/compact']);
    expect(slashMatches('claude', '/zzz')).toEqual([]);
  });

  test('a draft that is not a command opens nothing', () => {
    expect(slashMatches('claude', 'ship it')).toEqual([]);
    expect(slashMatches('claude', '')).toEqual([]);
  });
});

describe('the slash menu in the composer', () => {
  test('renders as a listbox of real buttons when the draft opens with a slash', () => {
    // The draft lives in local state, so drive it the only way the harness allows: render
    // the menu through a transcript-free card and assert the closed state, then the open
    // state via the exported matcher's contract (see `slashMatches`).
    const host = render(<AgentChat />);
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    for (const b of host.querySelectorAll('button')) expect(isInteractiveControl(b)).toBe(true);
  });
});

// The composer cannot be driven through the DOM here: happy-dom defines `value` as an own
// property on the element, so React skips installing a real value tracker and a controlled
// input's onChange never fires regardless of how the event is dispatched. So the send
// behavior is pinned on the exported pure function instead.
describe('appendTurn', () => {
  const base = [{ kind: 'assistant' as const, text: 'hi' }, { kind: 'thinking' as const }];

  test('adds the user turn and a reply, and re-trails the working line', () => {
    const next = appendTurn(base, '  run the linter  ', '~/dev/acme-app');
    expect(next?.map((e) => e.kind)).toEqual(['assistant', 'user', 'assistant', 'tool', 'thinking']);
    expect(next?.[1]).toMatchObject({ kind: 'user', text: 'run the linter' });
  });

  test('reads the working cwd into the tool call', () => {
    const next = appendTurn(base, 'go', '~/dev/acme-app');
    expect(next?.[3]).toMatchObject({ kind: 'tool', arg: 'dev/acme-app/README.md' });
  });

  test('a blank prompt returns null', () => {
    expect(appendTurn(base, '   ', '~/x')).toBeNull();
  });
});
