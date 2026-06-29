import { cloudflareModule } from '../../modules/cloudflare'

export default cloudflareModule.instance({
  name: 'web-poc',
  config: {
    workdir: 'packages/web-poc',
    // Not a secret (appears in dashboard URLs); resolved via `wrangler whoami`.
    accountId: '99a19e584439be0568f33aad0477372b',
    build: { command: 'bun run build', cwd: 'packages/web-poc' },
    // Pushed as Worker runtime secrets via `wrangler secret put` after deploy.
    // All of these must exist in production/secrets.yaml (SOPS-encrypted)
    // alongside TURSO_URL/TURSO_KEY. VOYAGE_API_KEY powers embeddings (the
    // active embedding provider); ANTHROPIC/OPENAI are only used if the optional
    // LLM agent jobs are run.
    workerSecrets: [
      'TURSO_URL',
      'TURSO_KEY',
      'VOYAGE_API_KEY',
      'ABLY_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'BETTER_AUTH_SECRET',
    ],
  },
})
