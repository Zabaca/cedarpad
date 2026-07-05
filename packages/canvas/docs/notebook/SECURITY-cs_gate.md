# Security note — why `cs_gate` cannot be dropped for in-app login alone

**Status:** open / revisit. **Severity:** high (pre-auth information disclosure)
+ medium (unauthenticated resource exhaustion). **Mitigation in place:** the
`cs_gate` edge gate is retained; this is the interim control. **Proper fix:**
Cloudflare Access (below).

This documents a real vulnerability that surfaces **if** the worker-level
`cs_gate` edge gate is removed and the deployment is left protected by the in-app
Better Auth login only. It was briefly done on the `integration` branch (commit
`ae294cb`) and reverted (`f339292`) once the consequences were confirmed. Recorded
here so the decision can be revisited deliberately, not rediscovered.

## Root cause

The production deployment **is a vite dev server**, not a static build. This is
load-bearing, not incidental: vite is the *runtime compiler* for the agent's
live-authored canvas components (`src/canvas-components/*.tsx` are dynamic-imported
and transpiled on request), so a static `vite build` cannot serve components
written after the build. The whole app therefore runs the dev stack inside the
Cloudflare Container (ADR 0001).

A vite dev server has **no authentication of its own** and, by design, serves:

- **raw source and source maps** — `GET /src/<path>.tsx` returns the transpiled
  module; source maps expose original source.
- **`/@fs/<absolute-path>`** — vite's filesystem endpoint reads any file under its
  `server.fs.allow` root (the workspace). `server.fs.deny` covers `.env`/`.git` by
  default, but application + monorepo source is readable.
- an **HMR websocket** and the full module graph.

## Why in-app login cannot cover it

Better Auth login gates the **React app content** (`src/App.tsx` `Gate`) and the
**bridge's `/api/*`** routes. It cannot gate the layer beneath it, because:

> The login page is itself served by vite. To render it, the worker must proxy the
> very first, unauthenticated request into the container. Any endpoint reachable to
> serve the login page is reachable to serve `/src/...` and `/@fs/...`.

So the client-side `Gate` never runs for a raw `curl https://…/src/notebook/auth.ts`
— that request is answered by vite before any React executes.

## Impact if `cs_gate` is dropped

1. **Pre-auth source disclosure (high).** Any anonymous visitor reads the full
   application + in-repo source via `/src/...` or `/@fs/<path>`, with no login.
   Confirmed empirically: during QA, `curl` of `/src/notebook/...tsx` with no cookie
   returned transpiled JS (200). This leaks implementation details, internal API
   shapes, and any secret/const that a bundled module references.
2. **Unauthenticated container cold-boot (medium — cost / DoS).** With the static
   `cs_gate` 401 gone, every anonymous request (a scanner hitting `GET /`) falls
   through to the sandbox proxy and can cold-boot the paid Cloudflare Container
   (`ensureStack` → `waitForPort`, tens of seconds). `max_instances: 1` +
   `sleepAfter: 5m` bound the blast radius, but it is a free lever to spin up the
   container repeatedly.
3. **Minor info disclosure via `/api/status`** — `buildRev` (exact serving commit
   SHA) + persistence health become publicly readable (it is on the bridge's
   open-list for the deploy poll).

The agent itself (the unsandboxed-RCE surface) stays behind the bridge session
gate even without `cs_gate`, so this is disclosure + cost, **not** remote code
execution. But #1 is a real pre-auth data exposure.

## Current mitigation (in place)

`cs_gate` is retained as a **first layer**: the worker requires the shared-secret
cookie (`?key=<GATE_SECRET>` sets it) on every path except `/health`, answering
unauthenticated traffic with a static 401 *before* anything reaches vite. Better
Auth login is the **second layer** (per-user identity). Code:
`packages/canvas/worker/index.ts` ("WHY THE EDGE GATE IS MANDATORY").

`cs_gate` is a single shared secret ("James-only across his devices" per ADR 0001),
so it is a coarse gate, not per-user auth — which is exactly why the login sits on
top of it.

## Proper fix (to revisit) — Cloudflare Access

Replace the shared-secret `cs_gate` with **Cloudflare Access** in front of the
worker route. Access is an identity-aware reverse proxy that authenticates at the
edge (SSO / one-time-PIN / email allowlist) *before* any request reaches the
worker or the container — so it closes both the source-disclosure and the
cold-boot vectors, with no shared secret to distribute and real per-user identity.
ADR 0001 already names this as the intended end state.

Migration outline:

1. **Cloudflare dashboard → Zero Trust → Access → Applications**: add a
   self-hosted application for `poc.cedarpad.com` (and the preview host if wanted).
2. Add an **Access policy** (e.g. allow a specific email / email domain, or a
   one-time-PIN list). This becomes the edge gate.
3. Once Access is live and verified, **remove `cs_gate` from the worker**: delete
   the gate block + `SIGN_IN` in `worker/index.ts`, drop `GATE_SECRET` from the
   `Env` interface and from `packages/infra/environments/*/canvas.ts` secrets, and
   drop the `cookie: cs_gate=…` header from `scripts/deploy.sh` (deploy tooling
   authenticates to Access via a service token instead — `CF-Access-Client-Id` /
   `CF-Access-Client-Secret`).
4. Keep the **Better Auth login** as the in-app per-user layer (unchanged).

**Ordering matters:** Access must be enforcing on the route *before* `cs_gate` is
removed from code, or there is an exposure window. Do not deploy the gate-removal
commit until Access is confirmed active.

## What is NOT possible

Exposing this deployment safely with **no edge gate at all** — relying on the
in-app login only — is not possible while the served artifact is an unauthenticated
dev server. The edge gate can change form (`cs_gate` → Cloudflare Access) but
cannot be removed outright without either (a) giving up live component authoring
(a static build, which the product depends on) or (b) accepting pre-auth source
disclosure + anonymous container boots.
