# Accessing the web-poc API (internal + remote)

How web-poc's HTTP API (`/v1/*`, Better Auth `/api/auth/*`) is reached now that
web-poc is merged into `@cedarpad/canvas` (see `../CONTEXT.md` → "How canvas
mounts it"). Covers the internal canvas↔web-poc path, the auth model, remote
access, and the "should canvas hold an API key" question.

## Where the API lives now (post-merge)

There is **no standalone web-poc endpoint** anymore. The API is exposed only
through the **canvas Worker origin**:

- **preview:** `https://agent-canvas-preview.james-99a.workers.dev`
- **prod:** `https://poc.cedarpad.com`

The canvas Worker **gates every path except `/health`** with the `cs_gate` cookie
(`packages/canvas/worker/index.ts`). So `/v1/*` currently sits behind the canvas
gate *and* web-poc's own auth. (See "Remote access" for the implication.)

## Internal communication (canvas ↔ web-poc)

web-poc is a **library mounted at two seams inside one process** — not a separate
service. There is no RPC between "canvas" and "web-poc".

**Frontend seam — direct React mount.** web-poc's UI is `WebPocApp`, lazy-imported
by canvas (`../web-poc/src/embed` in `packages/canvas/src/App.tsx`) into the same
React 19 tree. Its data client (`web-poc/src/api.ts`, `openapi-fetch`) uses
`baseUrl: ""` (`web-poc/src/config.ts` → `apiUrl`), i.e. **same-origin relative**
requests to `/v1/*` and `/api/auth/*`.

**Backend seam — in-process dispatch.** Those requests reach the canvas **bridge**
(`packages/canvas/server/bridge.ts`), which matches the path and calls
`webPocApp.fetch(req, webPocEnv)` — a direct in-process invocation of web-poc's
Hono app, **no network hop**. web-poc queries its own libSQL/Turso DB (the single
`@libsql/client` the bridge built and injected via `makeDb`). Canvas's own state is
separate (R2).

Request flow for a `/v1/...` call:

```
# dev
web-poc client (baseUrl "")  ->  localhost:4510/v1/...  (vite dev server)
    └─ vite proxy ('/v1' -> CANVAS_BRIDGE)  ->  localhost:4511  (bridge, bun)
        └─ bridge: path.startsWith('/v1/')  ->  webPocApp.fetch(req, webPocEnv)   # in-process
            └─ web-poc Hono app  ->  libSQL/Turso

# prod (one Cloudflare instance)
browser  ->  canvas Worker (poc.cedarpad.com)  ->  [cs_gate check]
    ->  sandbox preview-proxy  ->  container vite :4510
        └─ vite proxy ('/v1' -> bridge :4511)  ->  bridge (bun)
            └─ webPocApp.fetch(req, webPocEnv)  ->  web-poc Hono app  ->  remote Turso
```

The only real HTTP is the browser→origin leg (inherent to a SPA calling its API);
the server-side dispatch is a function call.

> **Ordering constraint:** in `bridge.ts` the `/v1` + `/api/auth/*` branch **must
> precede** canvas's own `/api/*` routes — `/api/auth/*` shares the `/api`
> namespace, so canvas's `/api/*` handlers would otherwise shadow Better Auth.

## Auth on `/v1/*` (`web-poc/worker/middleware.ts` `authMiddleware`)

`authMiddleware` runs `auth.api.getSession(headers)`; the Better Auth **apiKey**
plugin (`enableSessionForAPIKeys: true`, `web-poc/worker/auth.ts`) makes both a
session cookie and an `x-api-key` resolve through that one call.

| Caller | Credential | Identity |
|---|---|---|
| Logged-in browser (the embedded web-poc UI) | Better Auth **session cookie** | human — scope from the user's allowlist, target = active workspace |
| Remote / programmatic (no session) | **`x-api-key`** header | agent (`isAgent=true`) — scope from the key's `metadata.allowedWorkspaces`, target = `metadata.defaultWorkspaceId` |
| Local dev only | `DEV_AUTH_WORKSPACE` env + `x-dev-workspace` header | full access, no auth — **not set on preview/prod** |
| `/api/auth/*` (login/signup) | public | — |

- **Using the app needs no API key** — the session cookie from login carries every
  `/v1` call. That's how the demo login works.
- API keys are **owned by a user** (`referenceId → user_id`) and created in the UI
  (Settings → API Keys, `ApiKeysView`), scoped per workspace via key metadata.

## Remote / programmatic access

Because the canvas Worker gates everything, a remote `/v1` call today needs **two**
credentials:

1. **Canvas gate** — `cookie: cs_gate=<GATE_SECRET>` (or hit `?key=<GATE_SECRET>`
   once to set it). `GATE_SECRET` lives in the environment's `secrets.yaml`.
2. **web-poc auth** — `x-api-key: <key>` (or a session cookie).

```bash
curl -X POST https://agent-canvas-preview.james-99a.workers.dev/v1/observations \
  -H "cookie: cs_gate=<GATE_SECRET>" \
  -H "x-api-key: <your-api-key>" \
  -H "content-type: application/json" \
  -d '{"title":"...","body":"..."}'
```

(`x-api-key` uses the API-key path, so it does **not** need the browser
`Origin`/CSRF header that interactive `/api/auth` login requires.)

> **Design smell (open):** the `cs_gate` gate is a single shared secret meant for
> the interactive canvas, yet it now fronts the programmatic API too — defeating
> web-poc's per-workspace, revocable API keys. Option: **exempt `/v1/*` (and
> `/api/auth/*`) from `cs_gate`** in `worker/index.ts` so web-poc's own auth is the
> sole gate for those paths (restores pre-merge ergonomics). Tradeoff: it widens
> the public surface (login + `/v1` become directly hittable). Not yet done.

## Canvas → `/v1` (service-to-service): API key or not?

**Current state:** canvas does **not** call `/v1` server-side. The only caller is
web-poc's embedded UI (user session). This section is guidance for *if* canvas's
server side (the agent, a canvas tool) needs to read/write web-poc data.

The key point: canvas and web-poc are **one process sharing one DB handle**, so an
API key is not needed for *transport* — it's only about **identity + workspace
scope**. The real question is what identity canvas's writes should carry:

- **Fixed service/agent identity** (writes attributed to "the canvas agent") →
  an **API key is the idiomatic choice** (this is what the apiKey plugin is for).
  Scoped, revocable, audited.
- **The logged-in user's identity** → don't use a shared key; forward the user's
  session. The embedded UI already does this for UI-triggered writes.

If using a service key, **call it in-process** — don't make a network self-call to
`/v1`:

```ts
// canvas server code — no network hop, still runs authMiddleware
await webPocApp.fetch(new Request('http://internal/v1/observations', {
  method: 'POST',
  headers: { 'x-api-key': env.WEBPOC_SERVICE_KEY, 'content-type': 'application/json' },
  body: JSON.stringify({ title, body }),
}), webPocEnv)
```

Wiring: a key is owned by a user, so designate a **service user**, mint a scoped
key, store it as a Worker secret (`WEBPOC_SERVICE_KEY`) injected into the bridge
env, and inject the same value where canvas server code reads it.

| Option | Pros | Cons |
|---|---|---|
| **Service API key** (in-process `webPocApp.fetch` + `x-api-key`) | idiomatic; scoped, revocable, audited; uniform with external agents | service user + secret to manage; a shared identity |
| Call web-poc **service functions directly** (skip `/v1` + middleware) | fastest, no key | tighter coupling; re-implements auth/workspace context; skips contract validation |
| **Internal trust bypass** (a prod cousin of `DEV_AUTH_WORKSPACE`) | no key mgmt | loses revocability/scoping/audit; a new privileged path to secure |

**Recommendation:** if canvas needs autonomous, system-attributed writes, use a
scoped service API key via in-process `webPocApp.fetch()`. If the writes should be
the user's, forward the session instead. The decision hinges on **attribution**,
not on the fact that the packages are merged.
