import { cloudflareTunnelModule } from '../../../../vendor/zbc/modules/cloudflare-tunnel'
import cedarpadWsToken from './ws-token'

// The Cloudflare Tunnel that puts the cedarpad canvas workspace on the internet
// at ws.cedarpad.com — outbound-only, no port open on this box or the guest.
//
// ── The gate went up first, then the route ────────────────────────────────
// Until 2026-08-14 this routed ONLY the supervisor's control plane, because
// vite has no auth of its own and an unguarded `/*` would have served the
// canvas — and a bridge that can run agent turns with a real Claude token — to
// anyone who knows the hostname. `cedarpad-ws-access` now stands in front of
// the whole hostname (verified: 403 without the service token, 200 with it), so
// the `/*` rule is safe to add. That ordering is the point; reversing it opens
// the door for however long the second apply takes.
//
// Access covers EVERY path, control plane included, so cedarpad's edge Worker
// presents `CF-Access-Client-Id`/`-Secret` on `/__boot` too.
//
// Anything unmatched falls through to the `http_status:404` the module appends.
//
// ── Why cloudflared runs in the guest, not on this host ───────────────────
// agent-tunnel runs cloudflared on ryzen-9 itself, and copying that shape here
// would mean naming the guest's address — `10.196.88.90` — in this file. This
// repo already decided that is wrong twice over: ryzen-9-agent-isolation.test.ts
// asserts "the rendered script contains no literal tailnet address" and "the
// provisioner does not restate the hostname as a literal", because an address
// written down in a second place is an address that goes stale silently. And
// there is no `.incus` DNS on this box to launder it through — checked.
//
// So the tunnel runs inside cedarpad-ws and dials `127.0.0.1`, which cannot go
// stale, and the run token reaches it through `cedarpad-ws-tunnel-run`'s
// `volatileEnvFrom` — an import, not a copy in secrets.yaml. That also makes
// the tunnel's lifetime the workspace's lifetime, which is what it should be.
//
// The tunnel token is the one credential this arrangement puts inside the
// guest, and it is a different kind of thing from the secrets decision 8 keeps
// out: it grants exactly "be this tunnel", not "be cedarpad". No R2 key, no
// agent OAuth token and no BETTER_AUTH_SECRET rests here — those still arrive
// only when the edge Worker pushes them at boot.
export default cloudflareTunnelModule.instance({
  name: 'ws-tunnel',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    tunnelName: 'cedarpad-ws',
    apiToken: { from: 'ws-token', output: 'tokenValue' },
    zone: 'cedarpad.com',
    ingress: [
      {
        hostname: 'ws.cedarpad.com',
        // Anchored, and narrow: `^/__(boot|status)$` and nothing else. An
        // unanchored pattern would match any path CONTAINING the substring,
        // which is how a "control plane only" rule quietly becomes a wildcard.
        // MUST stay first — cloudflared takes the first match, so the catch-all
        // below would otherwise swallow the control plane.
        path: '^/__(boot|status)$',
        service: 'http://127.0.0.1:4599',
      },
      {
        // Everything else is the canvas: vite serves the pad and proxies /api
        // to the bridge, exactly as it does inside the Cloudflare container.
        // Deliberately NOT through the supervisor — restarting the supervisor
        // must never drop a canvas sync socket or a chat stream.
        //
        // ⚠️ THAT IS ABOUT TRAFFIC, NOT ABOUT THE STACK. Nothing here traverses
        // the supervisor, and restarting it still STOPS the canvas — vite is
        // the supervisor's child process, so it dies with its parent and stays
        // down until the Worker pushes an environment again.
        // `packages/canvas/scripts/ws-supervisor.ts` carries the mechanism and
        // the incident; `ws-service.ts` carries what it costs to apply.
        hostname: 'ws.cedarpad.com',
        service: 'http://127.0.0.1:4510',
      },
    ],
  },
  imports: [cedarpadWsToken],
})
