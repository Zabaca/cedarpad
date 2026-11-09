// The admin host (ADR-0026): admin.cedarpad.com, a read-only view of who is on the
// platform and what they run. Cloudflare Access gates the hostname at the edge
// (packages/infra/environments/production/admin-access.ts); this file is the second key —
// it verifies the Access assertion itself and refuses when it cannot, because this Worker
// is also reachable on hosts Access is not in front of.
//
// It never touches Better Auth: no session cookie is read, no role is checked. The person
// is whoever Access says they are, and Access admits exactly one address.
//
// Server-rendered HTML, no SPA: one page, one D1 read (adminOverview names every column it
// selects, so no secret can reach the markup), plus one request per Cloudflare-hosted
// workspace for its container's boot log — a route the CanvasContainer answers WITHOUT
// starting anything.

import type { Bindings } from '../web-poc/worker/context.ts';
import { type AdminOverview, adminOverview } from '../web-poc/lib/db/queries/admin-overview.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import {
  ACCESS_ASSERTION_HEADER,
  AUD_TAG,
  type Http,
  TEAM_DOMAIN,
  verifyAssertion,
} from './access-jwt.ts';
import { BOOTLOG_PATH } from './canvas-container.ts';
import { COORDS_HEADER } from './canvas-container-lifecycle.ts';
import type { Env } from './index.ts';
import { coordsForWorkspace } from './sandbox-resolver.ts';
import { parseWorkspaceMap } from './self-hosted.ts';

/** The one hostname this page is served on. Declared at the top level of wrangler.jsonc only. */
export const ADMIN_HOST = 'admin.cedarpad.com';

export const isAdminHost = (url: URL): boolean => url.hostname === ADMIN_HOST;

/** Where a workspace's compute is, and what it last said about itself. */
export type ContainerStatus =
  | { kind: 'vm' | 'sandbox'; origin: string }
  | { kind: 'durable'; running: boolean; lastBoot: { at: string; ms: number; outcome: string; detail?: string } | null }
  | { kind: 'unknown'; why: string };

export interface AdminDeps {
  /** The JWKS fetch port (global fetch in production). */
  fetch: Http;
  now: () => number;
  overview: () => Promise<AdminOverview>;
  containerStatus: (workspaceId: string) => Promise<ContainerStatus>;
}

const BOOTLOG_TIMEOUT_MS = 5_000;

export function defaultAdminDeps(env: Env): AdminDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    overview: () => adminOverview(createDbForWorker(env as unknown as Bindings)),
    containerStatus: (id) => containerStatusOf(env, id),
  };
}

/** The VM or the sandbox if self-hosted; else the CanvasContainer's own boot log. */
export async function containerStatusOf(env: Env, workspaceId: string): Promise<ContainerStatus> {
  const coords = coordsForWorkspace(workspaceId);
  const hosted = parseWorkspaceMap(env.SELF_HOSTED_WORKSPACES)[coords.canvasWorkspace];
  if (hosted) return { kind: hosted.sandbox ? 'sandbox' : 'vm', origin: hosted.origin };
  const ns = env.CanvasContainer;
  try {
    const req = new Request(`https://${ADMIN_HOST}${BOOTLOG_PATH}`, { headers: { [COORDS_HEADER]: JSON.stringify(coords) } });
    const res = await ns.get(ns.idFromName(coords.sandboxId)).fetch(req, { signal: AbortSignal.timeout(BOOTLOG_TIMEOUT_MS) });
    if (!res.ok) return { kind: 'unknown', why: `boot log answered ${res.status}` };
    const body = (await res.json()) as { running?: unknown; lastBoot?: unknown };
    return {
      kind: 'durable',
      running: body.running === true,
      lastBoot: (body.lastBoot ?? null) as Extract<ContainerStatus, { kind: 'durable' }>['lastBoot'],
    };
  } catch (e) {
    return { kind: 'unknown', why: e instanceof Error ? e.message : String(e) };
  }
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-frame-options': 'DENY',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};

const plain = (status: number, text: string) =>
  new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS } });

/** Everything on admin.cedarpad.com. Fails closed: no config, no assertion, or a bad one ⇒ refused. */
export async function handleAdminHost(request: Request, env: Env, deps: AdminDeps = defaultAdminDeps(env)): Promise<Response> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN ?? '';
  const aud = env.ACCESS_AUD ?? '';
  if (!TEAM_DOMAIN.test(teamDomain) || !AUD_TAG.test(aud)) return plain(503, 'admin is not configured');

  const assertion = request.headers.get(ACCESS_ASSERTION_HEADER) ?? '';
  const verdict = await verifyAssertion(assertion, { fetch: deps.fetch, teamDomain, aud, now: deps.now() });
  if (verdict.kind !== 'ok') {
    console.warn(`[admin] refused: ${verdict.why}`);
    return plain(403, 'forbidden');
  }

  const url = new URL(request.url);
  if (url.pathname !== '/' || (request.method !== 'GET' && request.method !== 'HEAD')) return plain(404, 'not found');

  const overview = await deps.overview();
  const statuses = new Map(
    await Promise.all(overview.workspaces.map(async (w) => [w.id, await deps.containerStatus(w.id)] as const)),
  );
  const html = renderAdminPage(overview, statuses, { viewer: verdict.subject, now: deps.now() });
  return new Response(request.method === 'HEAD' ? null : html, {
    headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS },
  });
}

/** HTML-escape a value for text and attribute positions alike. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const when = (d: Date | null | undefined): string =>
  d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—';

function statusText(s: ContainerStatus | undefined): string {
  if (!s) return '—';
  switch (s.kind) {
    case 'vm':
      return `VM · ${s.origin}`;
    case 'sandbox':
      return `sandbox · ${s.origin}`;
    case 'unknown':
      return `unknown · ${s.why}`;
    case 'durable': {
      const state = s.running ? 'running' : 'asleep';
      if (!s.lastBoot) return `cloudflare · ${state} · never booted`;
      const boot = `${s.lastBoot.outcome} ${(s.lastBoot.ms / 1000).toFixed(1)}s at ${when(new Date(s.lastBoot.at))}`;
      return `cloudflare · ${state} · last boot ${boot}`;
    }
  }
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return '<p class="empty">none</p>';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** Pure. Every value interpolated below goes through `esc`; cells are pre-escaped strings. */
export function renderAdminPage(
  o: AdminOverview,
  statuses: Map<string, ContainerStatus>,
  ctx: { viewer: string; now: number },
): string {
  const email = new Map(o.users.map((u) => [u.id, u.email]));
  const who = (id: string) => esc(email.get(id) ?? id);
  const wsName = new Map(o.workspaces.map((w) => [w.id, w.name]));
  const ws = (id: string) => (wsName.has(id) ? `${esc(wsName.get(id))} <span class="id">${esc(id)}</span>` : esc(id));

  const memberships = new Map<string, string[]>();
  for (const w of o.workspaces) {
    memberships.set(w.ownerUserId, [...(memberships.get(w.ownerUserId) ?? []), `${esc(w.name)} (owner)`]);
    for (const m of w.memberUserIds) memberships.set(m, [...(memberships.get(m) ?? []), esc(w.name)]);
  }

  const users = table(
    ['Email', 'Name', 'Role', 'Created', 'Last seen', 'Workspaces'],
    o.users.map((u) => [
      esc(u.email) + (u.banned ? ' <span class="flag">banned</span>' : ''),
      esc(u.name),
      esc(u.role ?? '—'),
      esc(when(u.createdAt)),
      esc(when(u.lastSeen)),
      (memberships.get(u.id) ?? []).join(', ') || '—',
    ]),
  );

  const workspaces = table(
    ['Workspace', 'Owner', 'Members', 'Canvases', 'Components', 'Skill files', 'Created', 'Container'],
    o.workspaces.map((w) => [
      ws(w.id),
      who(w.ownerUserId),
      w.memberUserIds.map(who).join(', ') || '—',
      esc(w.canvases),
      esc(w.components),
      esc(w.skillFiles),
      esc(when(w.createdAt)),
      esc(statusText(statuses.get(w.id))),
    ]),
  );

  const caps = (l: AdminOverview['shareLinks'][number]) =>
    [l.guestInteract && 'interact', l.guestEdit && 'edit', l.guestEditSource && 'edit source', l.guestChat && 'chat', l.guestHuddle && 'huddle']
      .filter(Boolean)
      .join(', ') || 'view';
  const shareLinks = table(
    ['Canvas', 'Workspace', 'Created by', 'Guests may', 'Created', 'State'],
    o.shareLinks.map((l) => [
      `<span class="id">${esc(l.canvasId)}</span>`,
      ws(l.workspaceId),
      who(l.createdBy),
      esc(caps(l)),
      esc(when(l.createdAt)),
      l.revokedAt ? esc(`revoked ${when(l.revokedAt)}`) : 'active',
    ]),
  );

  const mcpTokens = table(
    ['Workspace', 'MCP server', 'Created'],
    o.mcpTokens.map((t) => [ws(t.workspaceId), esc(t.mcpName), esc(when(t.createdAt))]),
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>cedarpad admin</title>
<style>
:root{--void:oklch(0.16 0 0);--surface:oklch(0.21 0 0);--line:oklch(0.32 0 0);--text:oklch(0.93 0.008 75);--muted:oklch(0.69 0.014 65);--accent:oklch(0.68 0.145 45);color-scheme:dark}
body{margin:0;background:var(--void);color:var(--text);font:14px/1.45 system-ui,-apple-system,sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:12px}
h1{font-size:18px;margin:0}h2{font-size:15px;margin:28px 0 8px}
.meta,.empty,.id{color:var(--muted)}.id{font:12px ui-monospace,Menlo,monospace}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:500;font-size:12px}tr:last-child td{border-bottom:0}
.flag{color:var(--accent);font-size:12px}
</style></head>
<body><main>
<header><h1>cedarpad admin</h1><span class="meta">${esc(ctx.viewer)} · ${esc(when(new Date(ctx.now)))} · read-only</span></header>
<h2>Users (${o.users.length})</h2>${users}
<h2>Workspaces (${o.workspaces.length})</h2>${workspaces}
<h2>Share links (${o.shareLinks.length})</h2>${shareLinks}
<h2>MCP tokens (${o.mcpTokens.length})</h2>${mcpTokens}
</main></body></html>`;
}
