import { cloudflareTokenModule } from '../../../../vendor/zbc/modules/cloudflare-token'

// The credential `admin-access` converges the admin.cedarpad.com Zero Trust
// application with, minted per-apply from CLOUDFLARE_ROOT_TOKEN and never at
// rest — games' railmid-access-token.ts is the pattern, for the same reason: the
// deploy token (CLOUDFLARE_API_TOKEN) carries Workers, R2, D1 and containers, and
// widening it to Access in the dashboard would be a fix in nobody's file.
//
// The groups the access module actually calls for this instance:
//   - "Access: Apps and Policies Read/Write" — list the account's applications to
//     find this one by domain, then create/converge it and its people policy.
//   - "Access: Organizations Read" — COMPARE `teamDomain` against the live
//     organisation. Read only: the Worker derives the issuer it verifies every
//     assertion against from that domain, so it is never chosen by an apply.
//   - "Access: Identity Providers Read" — report the organisation's providers.
//     None are declared here (they are organisation-wide, not this app's).
// No service-token groups: nothing here mints or admits one.
//
// `zones` is deliberately NOT set: the root token holds no "Zone Read" (see
// workspace/ws-token.ts), and Access is account-scoped anyway.
export default cloudflareTokenModule.instance({
  name: 'admin-access-token',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    tokenName: 'cedarpad-admin-access',
    permissions: [
      'Access: Apps and Policies Read',
      'Access: Apps and Policies Write',
      'Access: Organizations Read',
      'Access: Identity Providers Read',
    ],
  },
})
