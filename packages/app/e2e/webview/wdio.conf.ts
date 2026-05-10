/**
 * webdriverio config for the WebView e2e harness.
 *
 * The flow:
 *   1. `globalSetup` mints a worktree-scoped temp dir, seeds the recents
 *      store with a fresh repo, and spawns `tauri-webdriver` with
 *      `CEDARPAD_GLOBAL_DIR` set so the launched app inherits it.
 *   2. wdio connects to `tauri-webdriver` on :4444. Each spec gets a fresh
 *      session — `tauri-webdriver` launches the cedarpad binary, which
 *      auto-restores the seeded workspace via existing recents code.
 *   3. `globalTeardown` kills `tauri-webdriver` and rms the temp dir.
 *
 * Worktree-safe: `CEDARPAD_TMP` (set by `scripts/with-worktree-env.sh`) is
 * honoured by `mkdtempWorktreeScoped`, so two worktrees never collide on
 * temp paths. `tauri-webdriver`'s port (4444) is currently the only fixed
 * point — if you need to run two e2e suites in parallel from two
 * worktrees, override via `--port` in onPrepare. For slice 1 we accept
 * the single-port limitation: only one WebView e2e run per machine at a
 * time.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtempWorktreeScoped } from '../../modules/test-utils/worktreeTmp.ts'
import { seedRecentRepo } from './seedRecents.ts'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '../..')
const launchScript = join(here, 'launch-app.sh')

let driverProc: ChildProcess | null = null
let tmpDir: string | null = null

export const config: WebdriverIO.Config = {
  runner: 'local',
  specs: [join(here, 'specs/**/*.spec.ts')],
  maxInstances: 1,
  capabilities: [
    {
      'tauri:options': {
        application: launchScript,
      },
    },
  ],
  hostname: 'localhost',
  port: 4444,
  path: '/',
  logLevel: 'warn',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },
  // Pass per-test context (the seeded repo path) via the wdio shared store.
  // We can't put it in capabilities directly because tauri-webdriver only
  // forwards `application` and `args`; we expose it via a global on
  // process.env that the spec reads.
  onPrepare: async () => {
    tmpDir = await mkdtempWorktreeScoped('e2e-webview-')
    const seeded = await seedRecentRepo({ baseTmp: tmpDir })
    process.env.CEDARPAD_E2E_REPO = seeded.repoPath
    process.env.CEDARPAD_GLOBAL_DIR = seeded.globalDir
    // Slice 3 e2e isolation:
    //  - CEDARPAD_KEYCHAIN_MEMORY=1 swaps the OS keychain for an
    //    in-process HashMap so tests never touch the developer's real
    //    keychain.
    //  - CEDARPAD_E2E_FAKE_SDK=1 swaps the Claude Agent SDK for a
    //    deterministic fake (no network, no API key required).
    process.env.CEDARPAD_KEYCHAIN_MEMORY = '1'
    process.env.CEDARPAD_E2E_FAKE_SDK = '1'
    // Default key auto-populates the in-memory keychain so the existing
    // five specs (which were green before slice 3) don't have to type a
    // key on every fresh binary launch. The auth.spec.ts spec explicitly
    // clears it via `auth_delete_api_key` to exercise the first-launch
    // flow.
    process.env.CEDARPAD_E2E_DEFAULT_KEY = 'sk-ant-e2e-default'
    // Subscription-detect isolation: the auth probe checks
    // `${CLAUDE_CONFIG_DIR ?? ~/.claude}/.credentials.json` for an
    // OAuth login. On a developer machine with a real Claude Code
    // login, the host's credentials file would short-circuit the
    // detection to `'subscription'` and flip the existing API-key
    // specs into a path they were never designed for. Point the probe
    // at the e2e tmp dir (which has no credentials file) so detection
    // returns `'api-key'` whenever the in-memory keychain has a key
    // and `'none'` when it doesn't.
    process.env.CLAUDE_CONFIG_DIR = tmpDir
    // Opt the binary into the test-only `auth.setE2EOverride` channel
    // so the new auth-detect.spec.ts can flip modes per-test. Empty
    // string is fine — only the var's PRESENCE gates the channel.
    process.env.CEDARPAD_E2E_AUTH_MODE = ''

    driverProc = spawn('tauri-webdriver', ['--port', '4444'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    })
    driverProc.stdout?.on('data', (b: Buffer) => {
      process.stderr.write(`[tauri-webdriver] ${b}`)
    })
    driverProc.stderr?.on('data', (b: Buffer) => {
      process.stderr.write(`[tauri-webdriver] ${b}`)
    })
    // Wait for port to be reachable.
    await waitForPort('localhost', 4444, 10000)
  },
  // Between specs: tauri-webdriver tears down the cedarpad binary at session
  // end, but on macOS the kernel can hold the port / WebDriver bridge for a
  // short window. Pause briefly so the next session's binary launch finds a
  // clean slate.
  afterSession: async () => {
    await new Promise((r) => setTimeout(r, 500))
  },
  onComplete: async () => {
    if (driverProc) {
      driverProc.kill()
      driverProc = null
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true })
      tmpDir = null
    }
  },
}

async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const { connect } = await import('node:net')
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host, port })
      s.once('connect', () => {
        s.end()
        resolve(true)
      })
      s.once('error', () => resolve(false))
    })
    if (ok) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`tauri-webdriver did not open port ${port} within ${timeoutMs}ms`)
}

// Make appRoot available for debugging output.
void appRoot
