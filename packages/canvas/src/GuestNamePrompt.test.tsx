// #320 slice 2: the guest types their own display name on arrival. The inviter forwards a
// link and does not know who will open it, so the name cannot come from the link — and
// without one, presence marks every outsider identically as "Guest".
import './happydom-harness.ts';

import { afterEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { GuestNamePrompt } from './GuestNamePrompt';
import type { CurrentUser } from './identity';

const mounted: Array<ReturnType<typeof createRoot>> = [];
afterEach(async () => {
  await act(async () => {
    for (const r of mounted.splice(0)) r.unmount();
  });
});

const ANON: CurrentUser = { id: 'g1', color: 'red', kind: 'guest' };

async function mount(user: CurrentUser | null, onName: (n: string) => void = () => {}) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push(root);
  await act(async () => {
    root.render(<GuestNamePrompt user={user} onName={onName} />);
  });
  return el;
}

describe('GuestNamePrompt', () => {
  test('a named guest submits, and the prompt goes away', async () => {
    const named: string[] = [];
    const el = await mount(ANON, (n) => named.push(n));
    const input = el.querySelector('input') as HTMLInputElement;
    expect(input).toBeTruthy();
    input.value = '  Sam  ';
    await act(async () => {
      el.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    // Trimmed here, not at the identity seam, so what is shown is what was submitted.
    expect(named).toEqual(['Sam']);
    expect(el.querySelector('form')).toBeNull();
  });

  test('an empty name is not a name — the prompt stays', async () => {
    const named: string[] = [];
    const el = await mount(ANON, (n) => named.push(n));
    await act(async () => {
      el.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(named).toEqual([]);
    expect(el.querySelector('form')).toBeTruthy();
  });

  test('nothing to ask: a guest who already named themselves, or an unresolved identity', async () => {
    expect((await mount({ ...ANON, name: 'Sam' })).querySelector('form')).toBeNull();
    expect((await mount(null)).querySelector('form')).toBeNull();
  });
});
