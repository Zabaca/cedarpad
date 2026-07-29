import { z } from 'zod';
import type { Database } from '../web-poc/lib/db/index.ts';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
  getAcceptableInvitation,
  listPendingInvitations,
  revokeWorkspaceInvitation,
} from '../web-poc/lib/db/queries/invitations.ts';
import { getWorkspace } from '../web-poc/lib/db/queries/workspaces.ts';
import type { GateUser } from './auth-gate.ts';

// Workspace invitations (#179): owner-only issuance/revoke of email-bound single-use
// invite links, and the accept flow. An invitation is still the ONLY account-creation
// door, but it is now enforced one layer down: issuing one is what makes an address
// eligible for a magic link (`hasPendingInvitationForEmail`), and verifying that link
// is what creates the account. Nothing here mints a credential.
// GET never consumes (link prefetch must be safe); POST does.

// Single contract for the payloads (CLAUDE.md §7): the Shell inline client, the join
// page's inline client, and these handlers speak these shapes.
const CreateInvitationInput = z.object({ email: z.string().trim().email().max(200) });
const InvitationView = z.object({ token: z.string(), email: z.string(), url: z.string(), expiresAt: z.number() });
export type InvitationView = z.infer<typeof InvitationView>;

const invitePath = (token: string) => `/invite/${token}`;

/** Mints and emails a Better Auth magic link for `email`, landing the recipient on
 *  `callbackURL` once verified. Implemented in auth-gate.ts against the edge auth
 *  instance; the send itself is best-effort and never throws. */
export type SendSignInLink = (email: string, callbackURL: string) => Promise<void>;

/**
 * /api/workspaces/:id/invitations[/:token] — owner-only admin (member ≠ admin):
 *   POST {email}      → 201 InvitationView (the link, ALSO emailed to the invitee)
 *   GET               → { invitations: InvitationView[] } (pending, unexpired)
 *   DELETE /:token    → 204 (revoke while pending)
 * A non-owner member gets 403; a stranger 404 (they can't see the workspace at all).
 */
export async function handleInvitationsApi(
  request: Request,
  database: Database,
  user: GateUser,
  workspaceId: string,
  token: string | undefined,
  deps: { sendSignInLink: SendSignInLink },
): Promise<Response> {
  const ws = await getWorkspace(database, workspaceId, user.id);
  if (!ws) return Response.json({ error: 'workspace not found' }, { status: 404 });
  if (ws.ownerUserId !== user.id) return Response.json({ error: 'owner only' }, { status: 403 });

  if (request.method === 'POST' && !token) {
    const parsed = CreateInvitationInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid email' }, { status: 400 });
    const inv = await createWorkspaceInvitation(database, {
      workspaceId: ws.id,
      email: parsed.data.email,
      inviterUserId: user.id,
      nowMs: Date.now(),
    });
    // The invitation row exists FIRST, so the magic-link allowlist
    // (`hasPendingInvitationForEmail`) recognises this address and lets the link out.
    // Clicking it mints the invitee's account + session and lands them on the join
    // page, already signed in — one credential mechanism, no password anywhere.
    // Best-effort: the copyable `url` below still works if the mail never arrives.
    await deps.sendSignInLink(inv.email, invitePath(inv.id));
    const view: InvitationView = { token: inv.id, email: inv.email, url: invitePath(inv.id), expiresAt: inv.expiresAt.getTime() };
    return Response.json(view, { status: 201 });
  }
  if (request.method === 'GET' && !token) {
    const rows = await listPendingInvitations(database, ws.id, Date.now());
    const invitations: InvitationView[] = rows.map((i) => ({ token: i.id, email: i.email, url: invitePath(i.id), expiresAt: i.expiresAt.getTime() }));
    return Response.json({ invitations });
  }
  if (request.method === 'DELETE' && token) {
    const revoked = await revokeWorkspaceInvitation(database, { token, workspaceId: ws.id });
    return revoked ? new Response(null, { status: 204 }) : Response.json({ error: 'not pending' }, { status: 404 });
  }
  return new Response('method not allowed', { status: 405 });
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The /invite/:token page + accept endpoint. Reachable without a session (the auth
 * gate exempts it): the invitation token IS the credential, and it only opens for
 * its bound email.
 *
 * Since the passwordless cutover this page NEVER creates an account. The invitee
 * arrives here already signed in, because the invitation email was a magic link
 * whose callbackURL is this path. Landing here without a session means the link was
 * forwarded, expired, or opened in another browser — so the no-session branch just
 * re-sends one to the BOUND address (never to an address the visitor supplies). */
export async function handleInviteAccept(
  request: Request,
  database: Database,
  sessionUser: (GateUser & { email?: string }) | null,
  token: string,
  deps: { sendSignInLink: SendSignInLink },
): Promise<Response> {
  const now = Date.now();

  if (request.method === 'GET') {
    const found = await getAcceptableInvitation(database, token, now);
    if ('error' in found) return inviteErrorPage(found.error);
    return joinPage(found.row.email, sessionUser?.email ?? null);
  }

  if (request.method === 'POST') {
    const found = await getAcceptableInvitation(database, token, now);
    if ('error' in found) {
      const status = found.error === 'not_found' ? 404 : found.error === 'not_pending' ? 410 : 410;
      return Response.json({ error: found.error }, { status });
    }

    // Signed-in path: the session's email must match the binding.
    if (sessionUser) {
      const res = await acceptWorkspaceInvitation(database, { token, userId: sessionUser.id, email: sessionUser.email ?? '', nowMs: now });
      if (!res.ok) return Response.json({ error: res.reason }, { status: res.reason === 'email_mismatch' ? 403 : 410 });
      return Response.json({ ok: true, workspaceId: res.workspaceId });
    }

    // No session: re-send the sign-in link to the BOUND address and stop. Accepting
    // requires a session, and the only way to get one is that email — so the visitor
    // never influences where it goes and this cannot be used to enumerate or redirect.
    await deps.sendSignInLink(found.row.email, invitePath(token));
    return Response.json({ sent: true });
  }

  return new Response('method not allowed', { status: 405 });
}

const PAGE_STYLE = `:root{color-scheme:light dark}*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea;display:grid;place-items:center;min-height:100vh}main{width:min(380px,92vw)}h1{font-size:18px;margin:0 0 4px}p{color:#9a9aa2;margin:0 0 16px}input{width:100%;padding:10px;margin:6px 0;border-radius:8px;border:1px solid #2a2a2e;background:#141416;color:inherit}button{width:100%;padding:10px;margin-top:10px;border-radius:8px;border:0;background:#e05d38;color:#fff;font-weight:600;cursor:pointer}.err{color:#ff7a6b;min-height:1.2em;margin-top:8px}`;

function inviteErrorPage(reason: string): Response {
  const msg =
    reason === 'expired' ? 'This invitation has expired. Ask for a new link.'
    : reason === 'not_pending' ? 'This invitation was already used or revoked.'
    : 'This invitation link is not valid.';
  return new Response(
    `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title><style>${PAGE_STYLE}</style></head><body><main><h1>Invitation</h1><p>${escapeHtml(msg)}</p></main></body></html>`,
    { status: reason === 'not_found' ? 404 : 410, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

/** The join page. Signed in (the normal path — the invite email was a magic link
 * landing here): one Join button, with a mismatch surfaced before POSTing. Without
 * a session: a button that re-sends the link to the bound address. No account is
 * created here and no credential is collected — hence no name or password field. */
function joinPage(boundEmail: string, sessionEmail: string | null): Response {
  const signedIn = sessionEmail !== null;
  const mismatch = signedIn && sessionEmail?.toLowerCase() !== boundEmail;
  const body = mismatch
    ? `<h1>Wrong account</h1><p>This invitation is for <b>${escapeHtml(boundEmail)}</b>, but you are signed in as <b>${escapeHtml(sessionEmail ?? '')}</b>. Sign out and open the link again.</p>`
    : signedIn
      ? `<h1>Join workspace</h1><p>Join as <b>${escapeHtml(sessionEmail ?? '')}</b>.</p><button id=go>Join</button><div class=err id=err></div>`
      : `<h1>Join workspace</h1><p>This invitation is for <b>${escapeHtml(boundEmail)}</b>. We'll email that address a sign-in link — open it to join.</p><button id=go>Email me a sign-in link</button><div class=err id=err></div>`;
  const script = mismatch
    ? ''
    : `<script>document.getElementById('go').onclick=async()=>{const err=document.getElementById('err'),go=document.getElementById('go');err.textContent='';go.disabled=true;const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const d=await r.json().catch(()=>null);if(r.ok&&d&&d.workspaceId){location.href='/w/'+d.workspaceId;return;}if(r.ok&&d&&d.sent){go.remove();err.style.color='#9a9aa2';err.textContent='Link sent. It expires in 15 minutes.';return;}err.textContent=(d&&d.error)||'Could not join';go.disabled=false;};</script>`;
  return new Response(
    `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main>${script}</body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
