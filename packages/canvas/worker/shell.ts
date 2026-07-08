import { z } from 'zod';
import type { Bindings } from '../web-poc/worker/context.ts';
import type { Database } from '../web-poc/lib/db/index.ts';
import { createDbForWorker } from '../web-poc/worker/runtime.ts';
import { createWorkspace, getWorkspace, listWorkspaces } from '../web-poc/lib/db/queries/workspaces.ts';
import * as canvasRegistry from '../web-poc/lib/db/queries/canvases.ts';
import type { GateUser } from './auth-gate.ts';
import type { Env } from './index.ts';
import { DEFAULT_WORKSPACE_ID, readWorkspaceCookie } from './shell-routing.ts';

// The edge Shell's DB-touching half (ADR-0007, #46): the workspace registry API the
// launcher calls, and the static launcher HTML itself. Served entirely at the edge —
// listing/creating a workspace never wakes a container. The PURE routing/selection
// decisions live in `shell-routing.ts`.

const db = (env: Env) => createDbForWorker(env as unknown as Bindings);

// Single contract for the registry API payloads (CLAUDE.md §7): both the launcher's
// inline client and this handler speak these shapes.
const CreateWorkspaceInput = z.object({ name: z.string().trim().min(1).max(100) });
const WorkspaceView = z.object({ id: z.string(), name: z.string() });
export type WorkspaceView = z.infer<typeof WorkspaceView>;

/**
 * The Shell's workspace registry API (owner-scoped):
 *   GET  /api/workspaces           → { workspaces: WorkspaceView[] }
 *   POST /api/workspaces {name}     → the created WorkspaceView
 * The legacy `default` workspace is always presented first — it has no registry row
 * but is a real, openable workspace (the prod container).
 */
export async function handleWorkspacesApi(request: Request, env: Env, user: GateUser): Promise<Response> {
  if (request.method === 'GET') {
    const rows = await listWorkspaces(db(env), user.id);
    const workspaces: WorkspaceView[] = [
      { id: DEFAULT_WORKSPACE_ID, name: 'Default' },
      ...rows.map((w) => ({ id: w.id, name: w.name })),
    ];
    return Response.json({ workspaces });
  }
  if (request.method === 'POST') {
    const parsed = CreateWorkspaceInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
    const ws = await createWorkspace(db(env), { name: parsed.data.name, ownerUserId: user.id });
    return Response.json({ id: ws.id, name: ws.name }, { status: 201 });
  }
  return new Response('method not allowed', { status: 405 });
}

// Single contract for the canvas registry API (CLAUDE.md §7). Both the frontend's
// LeftPanel index and this handler speak these shapes.
const CreateCanvasInput = z.object({ name: z.string().trim().min(1).max(100) });
const RenameCanvasInput = z.object({ name: z.string().trim().min(1).max(100) });
const CanvasView = z.object({ id: z.string(), name: z.string() });
export type CanvasView = z.infer<typeof CanvasView>;

/**
 * Resolve the active workspace for a canvas-registry call from the `cs_workspace`
 * cookie (set by /w/:id), enforcing ownership. Returns the workspace id to scope by,
 * or null when the selection is an unknown/non-owned workspace (⇒ the caller 404s).
 * The `default` id needs no registry row (the legacy prod workspace).
 */
async function activeWorkspaceId(request: Request, database: Database, user: GateUser): Promise<string | null> {
  const selected = readWorkspaceCookie(request.headers.get('cookie')) ?? DEFAULT_WORKSPACE_ID;
  if (selected === DEFAULT_WORKSPACE_ID) return DEFAULT_WORKSPACE_ID;
  const ws = await getWorkspace(database, selected, user.id);
  return ws ? ws.id : null;
}

/**
 * The Canvas app's registry API, scoped to the active workspace (from `cs_workspace`):
 *   GET    /api/canvases            → { workspaceId, canvases: CanvasView[] }
 *   POST   /api/canvases {name}      → the created CanvasView (201)
 *   PATCH  /api/canvases/:id {name}  → the renamed CanvasView
 *   DELETE /api/canvases/:id         → 204
 * Mutations verify the target canvas belongs to the active workspace (never cross-
 * workspace). Mirrors handleWorkspacesApi — served at the edge, so listing/creating a
 * canvas never wakes a container.
 */
export async function handleCanvasesApi(
  request: Request,
  database: Database,
  user: GateUser,
  canvasId?: string,
): Promise<Response> {
  const workspaceId = await activeWorkspaceId(request, database, user);
  if (!workspaceId) return Response.json({ error: 'workspace not found' }, { status: 404 });

  if (!canvasId) {
    if (request.method === 'GET') {
      const rows = await canvasRegistry.list(database, workspaceId);
      const canvases: CanvasView[] = rows.map((c) => ({ id: c.id, name: c.name }));
      return Response.json({ workspaceId, canvases });
    }
    if (request.method === 'POST') {
      const parsed = CreateCanvasInput.safeParse(await request.json().catch(() => null));
      if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
      const row = await canvasRegistry.create(database, { workspaceId, name: parsed.data.name });
      return Response.json({ id: row.id, name: row.name }, { status: 201 });
    }
    return new Response('method not allowed', { status: 405 });
  }

  // Per-canvas mutations: the target must belong to the active workspace.
  const existing = await canvasRegistry.get(database, canvasId);
  if (!existing || existing.workspaceId !== workspaceId) {
    return Response.json({ error: 'canvas not found' }, { status: 404 });
  }
  if (request.method === 'PATCH') {
    const parsed = RenameCanvasInput.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: 'invalid name' }, { status: 400 });
    const row = await canvasRegistry.rename(database, canvasId, parsed.data.name);
    if (!row) return Response.json({ error: 'canvas not found' }, { status: 404 });
    return Response.json({ id: row.id, name: row.name });
  }
  if (request.method === 'DELETE') {
    await canvasRegistry.delete(database, canvasId);
    return new Response(null, { status: 204 });
  }
  return new Response('method not allowed', { status: 405 });
}

// The edge login page (ADR-0007, #47 cutover). With `cs_gate` gone, the edge Better Auth
// gate is the sole gate: any unauthenticated request to a non-public route is DENIED here
// and served this page instead of the container. It is self-contained static HTML (the
// no-container constraint — it can't pull `/src`) that posts email/password to the PUBLIC
// Better Auth endpoints (`/api/auth/*`, served at the edge), so a user signs in without a
// container ever waking. On success the session cookie is set and it reloads to `/`.
// Served with 401 so the deny is machine-legible (matches the pre-cutover gate status).
export function renderLogin(): Response {
  return new Response(LOGIN_HTML, {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const LOGIN_HTML = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea;display:grid;place-content:center;min-height:100vh}
.card{width:340px;border:1px solid #2c2c33;border-radius:12px;padding:24px;background:#141416}
h1{font-size:18px;font-weight:600;margin:0 0 4px}
p.sub{color:#8a8a92;margin:0 0 18px;font-size:13px}
label{display:block;font-size:12px;color:#8a8a92;margin:12px 0 4px}
input{width:100%;background:#0b0b0c;border:1px solid #2c2c33;color:#e7e7ea;padding:9px 12px;border-radius:8px;font:inherit}
button{width:100%;margin-top:18px;background:#4b6bff;border:0;color:#fff;padding:10px 16px;border-radius:8px;cursor:pointer;font:inherit}
button:disabled{opacity:.5;cursor:default}
.err{color:#ff6b6b;font-size:13px;margin-top:12px;min-height:16px}
.toggle{margin-top:16px;text-align:center;font-size:13px;color:#8a8a92}
.toggle a{color:#4b6bff;cursor:pointer}
#nameRow{display:none}
</style></head><body>
<div class=card>
  <h1>cedarpad</h1>
  <p class=sub id=sub>Sign in to continue.</p>
  <form id=f>
    <div id=nameRow><label for=name>Name</label><input id=name autocomplete=name></div>
    <label for=email>Email</label><input id=email type=email autocomplete=email required>
    <label for=pw>Password</label><input id=pw type=password autocomplete=current-password required>
    <button id=go type=submit>Log in</button>
    <div class=err id=err></div>
  </form>
  <div class=toggle id=toggle>No account yet? <a id=swap>Sign up</a></div>
</div>
<script>
let signup=false;
const err=document.getElementById('err'),go=document.getElementById('go');
document.getElementById('swap').onclick=()=>{
  signup=!signup;
  document.getElementById('nameRow').style.display=signup?'block':'none';
  document.getElementById('sub').textContent=signup?'Create your account.':'Sign in to continue.';
  go.textContent=signup?'Sign up':'Log in';
  document.getElementById('toggle').innerHTML=signup
    ?'Already have an account? <a id=swap>Log in</a>':'No account yet? <a id=swap>Sign up</a>';
  document.getElementById('swap').onclick=arguments.callee;
  err.textContent='';
};
document.getElementById('f').onsubmit=async(e)=>{
  e.preventDefault();err.textContent='';go.disabled=true;
  const email=document.getElementById('email').value.trim();
  const password=document.getElementById('pw').value;
  const name=document.getElementById('name').value.trim();
  const path=signup?'/api/auth/sign-up/email':'/api/auth/sign-in/email';
  const body=signup?{email,password,name:name||email}:{email,password};
  try{
    const r=await fetch(path,{method:'POST',credentials:'same-origin',
      headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(r.ok){location.href='/';return;}
    const d=await r.json().catch(()=>null);
    err.textContent=(d&&(d.message||d.error))||(signup?'Sign up failed':'Sign in failed');
  }catch(_){err.textContent='Something went wrong';}
  go.disabled=false;
};
</script></body></html>`;

// The launcher: a self-contained static page (no bundler, inline JS/CSS — the strict
// no-container constraint means it can't pull `/src`). Lists the user's workspaces from
// /api/workspaces, creates one, opens one by navigating to /w/:id (the Worker sets the
// selection cookie and proxies that workspace's container). Top nav establishes the
// Canvas/Notebook/Inbox frame; Notebook opens the static SPA at /notebook (PRD #49
// slice #58), Inbox opens the two-pane surface at /inbox (PRD #50 slice #62).
export function renderShell(): Response {
  return new Response(SHELL_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const SHELL_HTML = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea}
header{display:flex;align-items:center;gap:20px;padding:14px 22px;border-bottom:1px solid #26262b}
header h1{font-size:17px;font-weight:600;margin:0}
nav{display:flex;gap:6px}
nav button{background:none;border:0;color:#9a9aa2;font:inherit;padding:6px 12px;border-radius:7px;cursor:pointer}
nav button.on{background:#26262b;color:#e7e7ea}
nav button:disabled{opacity:.4;cursor:default}
.sp{flex:1}
#out{background:none;border:1px solid #34343b;color:#c9c9d0;padding:6px 12px;border-radius:7px;cursor:pointer}
main{max-width:720px;margin:36px auto;padding:0 22px}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(200px,1fr))}
.ws{border:1px solid #2c2c33;border-radius:11px;padding:16px;cursor:pointer;background:#141416}
.ws:hover{border-color:#4b6bff}
.ws b{display:block;font-size:15px}
.ws small{color:#8a8a92}
form{display:flex;gap:8px;margin:22px 0}
input{flex:1;background:#141416;border:1px solid #2c2c33;color:#e7e7ea;padding:9px 12px;border-radius:8px;font:inherit}
form button{background:#4b6bff;border:0;color:#fff;padding:9px 16px;border-radius:8px;cursor:pointer;font:inherit}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#8a8a92;margin:0 0 12px}
</style></head><body>
<header>
  <h1>cedarpad</h1>
  <nav>
    <button class=on title="Launcher">Canvas</button>
    <button id=nav-notebook title="Notebook">Notebook</button>
    <button id=nav-inbox title="Inbox">Inbox</button>
  </nav>
  <span class=sp></span>
  <button id=out>Sign out</button>
</header>
<main>
  <h2>Workspaces</h2>
  <div id=list class=grid>Loading…</div>
  <form id=make><input id=name placeholder="New workspace name" maxlength=100 required><button>Create</button></form>
</main>
<script>
const list=document.getElementById('list');
function open_(id){location.href='/w/'+encodeURIComponent(id);}
async function load(){
  const r=await fetch('/api/workspaces',{credentials:'same-origin'});
  if(!r.ok){list.textContent='Failed to load workspaces.';return;}
  const {workspaces}=await r.json();
  list.innerHTML='';
  for(const w of workspaces){
    const el=document.createElement('div');el.className='ws';
    el.innerHTML='<b></b><small>Open →</small>';el.querySelector('b').textContent=w.name;
    el.onclick=()=>open_(w.id);list.appendChild(el);
  }
}
document.getElementById('make').onsubmit=async(e)=>{
  e.preventDefault();const name=document.getElementById('name').value.trim();if(!name)return;
  const r=await fetch('/api/workspaces',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json'},body:JSON.stringify({name})});
  if(r.ok){const w=await r.json();open_(w.id);}else{alert('Could not create workspace');}
};
document.getElementById('nav-notebook').onclick=()=>{location.href='/notebook';};
document.getElementById('nav-inbox').onclick=()=>{location.href='/inbox';};
document.getElementById('out').onclick=async()=>{
  await fetch('/api/auth/sign-out',{method:'POST',credentials:'same-origin'}).catch(()=>{});
  location.href='/';
};
load();
</script></body></html>`;

// The Inbox surface (ADR-0007, PRD #50 slice #62): an Intercom-style two-pane page — a
// left list of the user's Conversations (waiting_on:human pinned + badged, unread dot,
// open/closed + workspace filters) and a right thread (transcript rendered from R2 via
// /api/inbox/:id, so it renders while the runner sleeps) with a reply box and close/reopen.
// Self-contained static HTML + fetch (the no-container constraint — it can't pull /src),
// mirroring renderShell. All data comes from the edge Inbox API on this same origin.
export function renderInbox(): Response {
  return new Response(INBOX_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const INBOX_HTML = `<!doctype html><html lang=en><head><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1"><title>cedarpad — Inbox</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#0b0b0c;color:#e7e7ea;height:100vh;display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:20px;padding:14px 22px;border-bottom:1px solid #26262b;flex:0 0 auto}
header h1{font-size:17px;font-weight:600;margin:0}
nav{display:flex;gap:6px}
nav button{background:none;border:0;color:#9a9aa2;font:inherit;padding:6px 12px;border-radius:7px;cursor:pointer}
nav button.on{background:#26262b;color:#e7e7ea}
.sp{flex:1}
#out{background:none;border:1px solid #34343b;color:#c9c9d0;padding:6px 12px;border-radius:7px;cursor:pointer}
.wrap{flex:1;display:flex;min-height:0}
.list{width:340px;border-right:1px solid #26262b;display:flex;flex-direction:column;min-height:0}
.filters{display:flex;gap:8px;padding:12px;border-bottom:1px solid #1e1e22;flex:0 0 auto}
.filters select{flex:1;background:#141416;border:1px solid #2c2c33;color:#e7e7ea;padding:6px 8px;border-radius:7px;font:inherit}
.items{overflow-y:auto;flex:1}
.item{padding:12px 14px;border-bottom:1px solid #1a1a1e;cursor:pointer}
.item:hover{background:#141416}
.item.sel{background:#17171b}
.item .top{display:flex;align-items:center;gap:8px}
.item b{font-size:14px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item small{color:#8a8a92;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.dot{width:8px;height:8px;border-radius:50%;background:#4b6bff;flex:0 0 auto}
.badge{font-size:10px;text-transform:uppercase;letter-spacing:.04em;padding:2px 6px;border-radius:5px;background:#3a2a12;color:#f0b866;flex:0 0 auto}
.badge.closed{background:#26262b;color:#8a8a92}
.thread{flex:1;display:flex;flex-direction:column;min-height:0}
.events{overflow-y:auto;flex:1;padding:18px 22px}
.empty{color:#8a8a92;margin:auto;text-align:center;padding:40px}
.ev{margin:0 0 10px;max-width:80%}
.ev.user{margin-left:auto}
.ev .bubble{padding:9px 13px;border-radius:11px;white-space:pre-wrap;word-break:break-word}
.ev.assistant .bubble{background:#161619;border:1px solid #26262b}
.ev.user .bubble{background:#243056;border:1px solid #33427a}
.ev.meta{color:#6f6f78;font-size:12px;max-width:100%}
.threadhead{display:flex;align-items:center;gap:10px;padding:12px 22px;border-bottom:1px solid #26262b;flex:0 0 auto}
.threadhead b{flex:1;font-size:15px}
.threadhead button{background:none;border:1px solid #34343b;color:#c9c9d0;padding:5px 12px;border-radius:7px;cursor:pointer;font:inherit}
.reply{display:flex;gap:8px;padding:12px 22px;border-top:1px solid #26262b;flex:0 0 auto}
.reply textarea{flex:1;background:#141416;border:1px solid #2c2c33;color:#e7e7ea;padding:9px 12px;border-radius:8px;font:inherit;resize:none;height:40px}
.reply button{background:#4b6bff;border:0;color:#fff;padding:0 18px;border-radius:8px;cursor:pointer;font:inherit}
.reply button:disabled{opacity:.5;cursor:default}
</style></head><body>
<header>
  <h1>cedarpad</h1>
  <nav>
    <button id=nav-canvas title="Launcher">Canvas</button>
    <button id=nav-notebook title="Notebook">Notebook</button>
    <button class=on title="Inbox">Inbox</button>
  </nav>
  <span class=sp></span>
  <button id=out>Sign out</button>
</header>
<div class=wrap>
  <div class=list>
    <div class=filters>
      <select id=fstatus>
        <option value=open>Open</option>
        <option value=closed>Closed</option>
        <option value="">All</option>
      </select>
      <select id=fworkspace><option value="">All workspaces</option></select>
    </div>
    <div id=items class=items>Loading…</div>
  </div>
  <div class=thread id=thread>
    <div class=empty>Select a conversation.</div>
  </div>
</div>
<script>
var items=document.getElementById('items'),thread=document.getElementById('thread');
var fstatus=document.getElementById('fstatus'),fworkspace=document.getElementById('fworkspace');
var current=null,list=[];
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function preview(it){return it.lastMessagePreview||it.summary||'';}
async function loadList(){
  var qs=[];if(fstatus.value)qs.push('status='+fstatus.value);
  if(fworkspace.value)qs.push('workspace='+encodeURIComponent(fworkspace.value));
  var r=await fetch('/api/inbox'+(qs.length?'?'+qs.join('&'):''),{credentials:'same-origin'});
  if(!r.ok){items.textContent='Failed to load.';return;}
  list=(await r.json()).items;
  var ws={};for(var i=0;i<list.length;i++)ws[list[i].workspaceId]=1;
  var cur=fworkspace.value;fworkspace.innerHTML='<option value="">All workspaces</option>';
  Object.keys(ws).forEach(function(w){var o=document.createElement('option');o.value=w;o.textContent=w;if(w===cur)o.selected=true;fworkspace.appendChild(o);});
  render();
}
function render(){
  items.innerHTML='';
  if(!list.length){items.innerHTML='<div class=empty>No conversations.</div>';return;}
  list.forEach(function(it){
    var el=document.createElement('div');el.className='item'+(current===it.id?' sel':'');
    var badge=it.waitingOn==='human'?'<span class=badge>waiting</span>':(it.status==='closed'?'<span class="badge closed">closed</span>':'');
    var dot=it.unread?'<span class=dot></span>':'';
    el.innerHTML='<div class=top>'+dot+'<b>'+esc(it.summary||it.sessionId||it.id)+'</b>'+badge+'</div><small>'+esc(preview(it))+'</small>';
    el.onclick=function(){openConv(it.id);};
    items.appendChild(el);
  });
}
function evRow(ev){
  if(ev.kind==='delta'&&ev.text){var role=ev.role==='user'?'user':'assistant';
    return '<div class="ev '+role+'"><div class=bubble>'+esc(ev.text)+'</div></div>';}
  if(ev.kind==='tool')return '<div class="ev meta">→ '+esc(ev.name)+'</div>';
  if(ev.kind==='thinking')return '<div class="ev meta">thinking…</div>';
  return '';
}
async function openConv(id){
  current=id;render();
  thread.innerHTML='<div class=empty>Loading…</div>';
  var r=await fetch('/api/inbox/'+encodeURIComponent(id),{credentials:'same-origin'});
  if(!r.ok){thread.innerHTML='<div class=empty>Failed to load conversation.</div>';return;}
  var d=await r.json();var c=d.conversation;
  var closed=c.status==='closed';
  var rows=(d.events||[]).map(evRow).join('');
  if(!rows)rows='<div class=empty>No history yet.</div>';
  thread.innerHTML=
    '<div class=threadhead><b>'+esc(c.summary||c.sessionId)+'</b>'+
    '<button id=toggle>'+(closed?'Reopen':'Close')+'</button></div>'+
    '<div class=events id=events>'+rows+'</div>'+
    '<div class=reply><textarea id=msg placeholder="Reply to the agent…"></textarea>'+
    '<button id=send>Send</button></div>';
  var ev=document.getElementById('events');ev.scrollTop=ev.scrollHeight;
  document.getElementById('toggle').onclick=function(){toggle(id,closed?'reopen':'close');};
  document.getElementById('send').onclick=function(){send(id);};
}
async function toggle(id,action){
  await fetch('/api/inbox/'+encodeURIComponent(id)+'/'+action,{method:'POST',credentials:'same-origin'});
  await loadList();openConv(id);
}
async function send(id){
  var msg=document.getElementById('msg'),btn=document.getElementById('send');
  var text=msg.value.trim();if(!text)return;btn.disabled=true;
  var r=await fetch('/api/inbox/'+encodeURIComponent(id)+'/reply',{method:'POST',credentials:'same-origin',
    headers:{'content-type':'application/json'},body:JSON.stringify({message:text})});
  btn.disabled=false;
  if(r.ok){msg.value='';await loadList();openConv(id);}else{alert('Reply failed');}
}
fstatus.onchange=loadList;fworkspace.onchange=loadList;
document.getElementById('nav-canvas').onclick=function(){location.href='/';};
document.getElementById('nav-notebook').onclick=function(){location.href='/notebook';};
document.getElementById('out').onclick=async function(){
  await fetch('/api/auth/sign-out',{method:'POST',credentials:'same-origin'}).catch(function(){});
  location.href='/';
};
loadList();
</script></body></html>`;
