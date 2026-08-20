import { cloudflareTokenModule } from '../../../../vendor/zbc/modules/cloudflare-token'

// The Cloudflare credential for the cedarpad workspace tunnel, minted per-apply
// from CLOUDFLARE_ROOT_TOKEN.
//
// CLOUDFLARE_AGENT_TUNNEL_TOKEN could already do all of this — it holds tunnel,
// Access and zone scope today. It is deliberately not reused, for the reason
// varnick-deploy-token.ts gives for keeping deploy and DNS apart: these are two
// services that should be able to part ways. agent-host's credential belongs to
// agent-host, and if the cedarpad workspace ever moves off this box its
// credential leaves with it instead of being quietly shared.
//
// Scopes are the four this actually exercises:
//   - "Cloudflare Tunnel Write"          create the tunnel, set its ingress
//   - "Zone Read"                       resolve cedarpad.com to a zone id
//   - "Access: Apps and Policies Write"  the application and its policy
//   - "Access: Service Tokens Write"     the bearer the edge Worker presents
//   - "DNS Write"                        the ws.cedarpad.com CNAME
//
// `zones` is deliberately NOT set, exactly as varnick-dns-token.ts explains:
// resolving a zone NAME to an id happens with the ROOT token, and root-ryzen-cf
// holds only "Account API Tokens Write" — verified again here, its /zones is
// empty. Setting `zones` would fail the apply at zone lookup rather than tighten
// anything, so the zone-scoped DNS group lands on every zone in the account.
// Revisit together with varnick-dns-token if root ever gains "Zone Read".
export default cloudflareTokenModule.instance({
  name: 'ws-token',
  config: {
    accountId: '99a19e584439be0568f33aad0477372b',
    tokenName: 'cedarpad-ws',
    permissions: [
      'Cloudflare Tunnel Write',
      'Zone Read',
      'Access: Apps and Policies Write',
      'Access: Service Tokens Write',
      'DNS Write',
    ],
  },
})
