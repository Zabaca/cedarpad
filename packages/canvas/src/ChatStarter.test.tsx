// The canvas chat-start control (CEDA-189MC6). It is a prompt, not a button: the old
// "＋ New chat" made an empty card and left you to type into it. These cover the two
// states (rest / focused) and the one contract that matters — submitting hands the typed
// prompt to the creator, so the chat is never started empty.
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { ChatStarter } from './ChatStarter';

const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

async function mount(props: Partial<Parameters<typeof ChatStarter>[0]> = {}) {
  const started: string[] = [];
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(<ChatStarter onStart={(p) => started.push(p)} {...props} />);
  });
  return { el, started };
}

/** Type into the focused starter's field the way React sees a real keystroke. Assigning
 *  `.value` directly is invisible to React's value tracker (no onChange), so go through
 *  the prototype's native setter — the standard controlled-input testing dance. */
async function type(el: HTMLElement, text: string) {
  const ta = el.querySelector('.chat-starter-input') as HTMLTextAreaElement;
  await act(async () => {
    ta.value = text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return ta;
}

const open = async (el: HTMLElement) => {
  await act(async () => {
    (el.querySelector('.chat-starter-rest') as HTMLButtonElement).click();
  });
};

describe('ChatStarter', () => {
  test('at rest it is a compact prompt bar, not an "add chat" button', async () => {
    const { el } = await mount();
    const rest = el.querySelector('.chat-starter-rest');
    expect(rest).toBeTruthy();
    expect(rest?.textContent).toContain('start a chat');
    expect(el.querySelector('.chat-starter-input')).toBeNull(); // the field appears on focus
  });

  test('focusing it opens the command line with a field, suggestions, and Run', async () => {
    const { el } = await mount();
    await open(el);
    expect(el.querySelector('.chat-starter-input')).toBeTruthy();
    expect(el.querySelectorAll('.chat-starter-sug').length).toBeGreaterThan(0);
    expect(el.querySelector('.chat-starter-run')?.textContent).toContain('Run');
  });

  test('submitting hands the typed prompt to the creator and collapses back to rest', async () => {
    const { el, started } = await mount();
    await open(el);
    await type(el, '  build me a kanban  ');
    const run = el.querySelector('.chat-starter-run') as HTMLButtonElement;
    expect(run.type).toBe('submit'); // happy-dom won't submit off a click, so drive the form
    await act(async () => {
      (el.querySelector('form') as HTMLFormElement).requestSubmit();
    });
    expect(started).toEqual(['build me a kanban']); // trimmed, and it IS the first turn
    expect(el.querySelector('.chat-starter-rest')).toBeTruthy(); // back at rest
  });

  test('an empty prompt starts nothing — Run stays disabled', async () => {
    const { el, started } = await mount();
    await open(el);
    await type(el, '   ');
    expect((el.querySelector('.chat-starter-run') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      (el.querySelector('.chat-starter-run') as HTMLButtonElement).click();
    });
    expect(started).toEqual([]);
  });

  test('Enter submits; Shift+Enter does not (multi-line prompts survive)', async () => {
    const { el, started } = await mount();
    await open(el);
    const ta = await type(el, 'first line');
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    });
    expect(started).toEqual([]);
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(started).toEqual(['first line']);
  });

  test('Escape abandons the prompt and returns to rest', async () => {
    const { el, started } = await mount();
    await open(el);
    const ta = await type(el, 'never mind');
    await act(async () => {
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(started).toEqual([]);
    expect(el.querySelector('.chat-starter-rest')).toBeTruthy();
  });

  test('a suggestion fills the field rather than starting a chat outright', async () => {
    const { el, started } = await mount();
    await open(el);
    const sug = el.querySelector('.chat-starter-sug') as HTMLButtonElement;
    const label = sug.textContent ?? '';
    await act(async () => {
      sug.click();
    });
    expect((el.querySelector('.chat-starter-input') as HTMLTextAreaElement).value).toBe(label);
    expect(started).toEqual([]); // you still get to edit it before running
  });

  test('the scope tag reports where the new chat will land', async () => {
    const { el } = await mount({ scope: () => 'next to Chat 2' });
    await open(el);
    expect(el.querySelector('.chat-starter-scope')?.textContent).toContain('next to Chat 2');
  });

  test('disabled until the editor is ready: no field, no start', async () => {
    const { el, started } = await mount({ disabled: true });
    const rest = el.querySelector('.chat-starter-rest') as HTMLButtonElement;
    expect(rest.disabled).toBe(true);
    await act(async () => {
      rest.click();
    });
    expect(started).toEqual([]);
  });
});
