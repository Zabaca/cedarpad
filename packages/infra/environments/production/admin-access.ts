import { cloudflareAccessModule } from '../../../../vendor/zbc/modules/cloudflare-access'
import accessToken from './admin-access-token'

// The lock on admin.cedarpad.com: a Cloudflare Zero Trust application in front of
// the whole host, and who may pass it (ADR-0026).
//
// ── The host IS the application ──────────────────────────────────────────
// Every other Zabaca admin surface is a PATH
// on a public host. This one is a host of its own on purpose: the admin page reads
// no Better Auth session at all, so nothing on app.cedarpad.com — its cookies, its
// sign-in, its role checks — is in play, and Access can gate the entire hostname
// without putting a wall in front of anything public.
//
// ── The Worker verifies the assertion too ────────────────────────────────
// Access protects only the hostnames it sits in front of, and the agent-canvas
// Worker is ALSO reachable at app.cedarpad.com and (preview) workers.dev. So
// worker/access-jwt.ts checks the `Cf-Access-Jwt-Assertion` on every admin request
// against this team's keys and this application's `aud`, and refuses when either
// is missing. Both reach the Worker as secrets through canvas.ts, so nobody
// hand-copies a 64-character tag.
//
// ── What is deliberately NOT declared ────────────────────────────────────
// `identityProviders` and `orgName` belong to the whole organisation (Zabaca,
// zabaca.cloudflareaccess.com, checked against another Zabaca stack on 2026-09-07);
// declaring them here would converge them behind every application on the
// account. `teamDomain` is declared because it is COMPARED, never chosen.
// No service token: the only caller is a person in a browser.
export default cloudflareAccessModule.instance({
  name: 'admin-access',
  imports: [accessToken],
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    apiToken: { from: 'admin-access-token', output: 'tokenValue' },
    teamDomain: 'zabaca.cloudflareaccess.com',
    name: 'cedarpad admin',
    domain: 'admin.cedarpad.com',
    emails: ['james@zabaca.com'],
    sessionDuration: '24h',
    appLauncherVisible: false,
  },
})
