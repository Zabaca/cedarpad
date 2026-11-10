import { defineConfig } from './vendor/zbc/src/index'

export default defineConfig({
  project: 'cedarpad',
  // The default workspace's compute (an sbx sandbox) is not a zbc environment: it is built and
  // replaced by `bun run deploy:sandbox` (ADR-0028). The `workspace` environment that converged a
  // VM on ryzen-9 was removed with the VM.
  environments: ['production', 'preview'],
})
