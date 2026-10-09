// GithubRepoCard is a display card: the pasted repo's name, linked to its URL. It makes no
// requests. Needs happy-dom (side-effect import stays first).
import './happydom-harness.ts';

import { expect, test } from 'bun:test';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import GithubRepoCard from './canvas-components/GithubRepoCard';

test('renders the repo name linked to its URL, with no clone controls', () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => createRoot(host).render(<GithubRepoCard repo="vercel/next.js" url="https://github.com/vercel/next.js" />));
  const a = host.querySelector('a');
  expect(a?.textContent).toBe('vercel/next.js');
  expect(a?.getAttribute('href')).toBe('https://github.com/vercel/next.js');
  expect(host.querySelector('button')).toBeNull();
});
