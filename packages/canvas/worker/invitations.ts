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
// invite links, and the accept flow — which is the ONLY account-creation door
// (AUTH_DISABLE_SIGNUP stays on globally; the `signUp` seam below is implemented in
// index.ts with a per-request Better Auth instance that allows signup for exactly
// this guarded path). GET never consumes (link prefetch must be safe); POST does.

// Single contract for the payloads (CLAUDE.md §7): the Shell inline client, the join
// page's inline client, and these handlers speak these shapes.
const CreateInvitationInput = z.object({ email: z.string().trim().email().max(200) });
const AcceptInput = z.object({ name: z.string().trim().min(1).max(100).optional(), password: z.string().min(8).max(200).optional() });
const InvitationView = z.object({ token: z.string(), email: z.string(), url: z.string(), expiresAt: z.number() });
export type InvitationView = z.infer<typeof InvitationView>;

const invitePath = (token: string) => `/invite/${token}`;

/**
 * /api/workspaces/:id/invitations[/:token] — owner-only admin (member ≠ admin):
 *   POST {email}      → 201 InvitationView (the copyable link)
 *   GET               → { invitations: InvitationView[] } (pending, unexpired)
 *   DELETE /:token    → 204 (revoke while pending)
 * A non-owner member gets 403; a stranger 404 (they can't see the workspace at all).
 */
export async function handleInvitationsApi(
  request: Request,
  database: Database,
  user: GateUser,
  workspaceId: string,
  token?: string,
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

/** The guarded account-creation seam: implemented in index.ts against Better Auth
 *  with signup enabled for THIS call only. Returns the new user id + the session
 *  set-cookie so the invitee lands signed in. */
export type InviteSignUp = (input: { email: string; name: string; password: string }) => Promise<{ userId: string; setCookie: string }>;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The /invite/:token page + accept endpoint. Reachable without a session (the auth
 * gate exempts it): the invitation token IS the credential, and it only opens for
 * its bound email. */
export async function handleInviteAccept(
  request: Request,
  database: Database,
  sessionUser: (GateUser & { email?: string }) | null,
  token: string,
  deps: { signUp: InviteSignUp },
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

    // No session: create the account through the guarded door, for the bound email only.
    const parsed = AcceptInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !parsed.data.password) return Response.json({ error: 'name and password required' }, { status: 400 });
    const created = await deps.signUp({
      email: found.row.email,
      name: parsed.data.name ?? found.row.email,
      password: parsed.data.password,
    });
    const res = await acceptWorkspaceInvitation(database, { token, userId: created.userId, email: found.row.email, nowMs: now });
    if (!res.ok) return Response.json({ error: res.reason }, { status: 410 });
    return Response.json({ ok: true, workspaceId: res.workspaceId }, { headers: { 'set-cookie': created.setCookie } });
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

/** The join page. If a session exists its email is shown; a mismatch is surfaced
 * client-side before POSTing. Without a session it collects name + password for
 * the BOUND email (field fixed, not editable). */
function joinPage(boundEmail: string, sessionEmail: string | null): Response {
  const signedIn = sessionEmail !== null;
  const mismatch = signedIn && sessionEmail?.toLowerCase() !== boundEmail;
  const body = mismatch
    ? `<h1>Wrong account</h1><p>This invitation is for <b>${escapeHtml(boundEmail)}</b>, but you are signed in as <b>${escapeHtml(sessionEmail ?? '')}</b>. Sign out and open the link again.</p>`
    : signedIn
      ? `<h1>Join workspace</h1><p>Join as <b>${escapeHtml(sessionEmail ?? '')}</b>.</p><button id=go>Join</button><div class=err id=err></div>`
      : `<h1>Join workspace</h1><p>Create your account for <b>${escapeHtml(boundEmail)}</b>.</p><input id=name placeholder="Your name"><input id=pw type=password placeholder="Password (8+ characters)"><button id=go>Create account & join</button><div class=err id=err></div>`;
  const script = mismatch
    ? ''
    : `<script>document.getElementById('go').onclick=async()=>{const err=document.getElementById('err');err.textContent='';const payload=${signedIn ? '{}' : `{name:document.getElementById('name').value,password:document.getElementById('pw').value}`};const r=await fetch(location.pathname,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const d=await r.json().catch(()=>null);if(r.ok&&d&&d.workspaceId){location.href='/w/'+d.workspaceId;}else{err.textContent=(d&&d.error)||'Could not join';}};</script>`;
  return new Response(
    `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title><style>${PAGE_STYLE}</style></head><body><main>${body}</main>${script}</body></html>`,
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
