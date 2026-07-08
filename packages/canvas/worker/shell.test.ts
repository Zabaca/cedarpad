import { describe, expect, test } from 'bun:test';

import { renderLogin } from './shell.ts';

// The edge login page is what the SOLE gate (edge Better Auth, #45) serves on a deny
// after the #47 cutover — replacing the deleted cs_gate `?key=` page. It must let an
// unauthenticated user actually sign in, at the edge, without waking a container.
describe('renderLogin — the post-cutover deny page (edge Better Auth is the sole gate)', () => {
  test('is a 401 HTML deny', async () => {
    const res = renderLogin();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
    await res.text(); // drain
  });

  test('posts credentials to the PUBLIC edge Better Auth endpoints (so login needs no container)', async () => {
    const html = await renderLogin().text();
    expect(html).toContain('/api/auth/sign-in/email');
    expect(html).toContain('/api/auth/sign-up/email');
  });

  test('is the Better Auth login, NOT the deleted cs_gate ?key= page', async () => {
    const html = await renderLogin().text();
    expect(html).not.toContain('?key=');
    expect(html).not.toContain('cs_gate');
  });
});
