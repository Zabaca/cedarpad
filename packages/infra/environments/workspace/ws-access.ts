import { cloudflareAccessModule } from '../../../../vendor/zbc/modules/cloudflare-access'
import cedarpadWsToken from './ws-token'

// The Zero Trust policy in front of ws.cedarpad.com.
//
// Applied BEFORE cedarpad-ws-tunnel gains its `/*` rule, never after: until this
// exists the tunnel routes only `^/__(boot|status)$`, which is bearer-checked and
// harmless. The moment `/*` points at vite, the hostname serves a dev server with
// no auth of its own and a bridge that can run agent turns with a real Claude
// token — so the gate has to be standing first.
//
// ── Only a service token, deliberately ────────────────────────────────────
// The browser never talks to this hostname. cedarpad's edge Worker does, and it
// is the thing that already authenticated the human (Better Auth session, then
// the workspace ownership check in worker/shell-routing.ts). Adding an email
// policy here would put a SECOND login in front of a user who is already signed
// in, and — worse — would make the canvas reachable by anyone who can satisfy
// Cloudflare Access, bypassing the ownership check the Worker does. The Worker
// is the only legitimate caller, so it is the only principal.
//
// The `include` (rather than `require`) shape leaves room to add an email rule
// later for direct human debugging without rewriting the policy.
export default cloudflareAccessModule.instance({
  name: 'ws-access',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    apiToken: { from: 'ws-token', output: 'tokenValue' },
    name: 'cedarpad workspace (ryzen-9)',
    domain: 'ws.cedarpad.com',
    serviceTokenName: 'cedarpad-edge-worker',
  },
  imports: [cedarpadWsToken],
})
