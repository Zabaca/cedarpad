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
//
// ── Migrated to the general module at zbc-core-v0.11.0 ────────────────────
//
// The module this instance names can now express a HUMAN principal — `emails`
// on their own `allow` policy, `identityProviders`, a session that issues a
// cookie. None of that is wanted here, and the paragraph above is why. What
// matters for this file is that the same policy is still expressible, and two
// values had to become explicit to keep it:
//
//   `sessionDuration: '0s'` — it was the DEFAULT and is now `'24h'`. `0s` means
//   every request is evaluated and no cookie is ever issued, which is exactly
//   right for a caller that presents its token on every request: a cookie would
//   let a leaked one outlive the token. Left unstated, this application would
//   start handing the edge Worker a 24h session it never asked for.
//
//   `appLauncherVisible: true` — measured, not guessed. The old module never
//   sent the field, so Cloudflare's own default applied and the live
//   application reads `app_launcher_visible: true`.
//
//   This line found a defect rather than merely avoiding one. The general
//   module sent the field on every apply, defaulted it to `false`, and computed
//   `changed` from name, domain and session duration alone — so omitting it
//   here would have flipped live state while the apply printed `unchanged`.
//   Fixed in zbc-core-v0.12.0: the default is now `true`, matching Cloudflare's
//   own and therefore matching what omitting the field has always meant, and
//   the apply compares every field it writes.
//
//   KEPT EXPLICIT even though it now equals the default, and that is the point
//   rather than an oversight: the default is the thing that moved under a live
//   application. A value visible in production is declared where it is wanted,
//   not inherited from a module that has already changed its mind once.
//
// Everything else migrates by doing nothing, which is the point of the
// promotion. `emails` defaults to empty, so no people policy is declared.
// `serviceTokenPolicyName` defaults to `"<serviceTokenName> service token"` —
// exactly what the old module named it — so the live policy
// "cedarpad-edge-worker service token" is FOUND and converged rather than left
// standing as drift beside a new one. `teamDomain` stays undeclared because
// nothing here verifies an Access assertion: the Worker presents a service
// token, it does not check an issuer.
export default cloudflareAccessModule.instance({
  name: 'ws-access',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    apiToken: { from: 'ws-token', output: 'tokenValue' },
    name: 'cedarpad workspace (ryzen-9)',
    domain: 'ws.cedarpad.com',
    serviceTokenName: 'cedarpad-edge-worker',
    sessionDuration: '0s',
    appLauncherVisible: true,
  },
  imports: [cedarpadWsToken],
})
