import { cloudflareModule } from '../../modules/cloudflare'

export default cloudflareModule.instance({
  name: 'web-poc',
  config: {
    workdir: 'packages/web-poc',
    // Not a secret (appears in dashboard URLs); resolved via `wrangler whoami`.
    accountId: '99a19e584439be0568f33aad0477372b',
    build: { command: 'bun run build', cwd: 'packages/web-poc' },
    // Pushed as Worker runtime secrets via `wrangler secret put` after deploy.
    workerSecrets: ['TURSO_URL', 'TURSO_KEY'],
  },
})
