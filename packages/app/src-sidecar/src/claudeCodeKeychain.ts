/**
 * macOS Keychain reader for the Claude Code SDK's credentials item.
 *
 * Reads the keychain item `Claude Code-credentials` (account = `$USER`)
 * — the same item the SDK reads on modern macOS. The auth probe consults
 * this between the credentials-file check and the BYOK check so users
 * who signed in with `claude /login` (which on modern macOS writes
 * *only* to the keychain) are recognised as having subscription auth.
 *
 * We shell out to `security(1)` rather than going through a native
 * keychain binding because:
 *
 *   1. Bun's distributed binary is stable-signed by the Bun project, so
 *      the macOS ACL grant ("Always Allow") survives across cedarpad
 *      rebuilds — the read happens under Bun's identity, not the
 *      freshly-resigned cedarpad binary's. (Doing this from the Tauri
 *      Rust shell forced the user to re-grant on every `cargo build`.)
 *   2. `security` is part of the macOS base install — no extra deps.
 *   3. Exit code 44 unambiguously means "item not found", so we don't
 *      need to grep stderr to distinguish that from a real failure.
 *
 * Trade-off: Bun's identity now holds the keychain grant, not
 * cedarpad's. For a single-user local tool that's acceptable — any
 * other process running under the user's Bun would also have access,
 * but the credentials are already user-scoped. Documented in the
 * companion PR.
 *
 * E2E gate: when `CEDARPAD_KEYCHAIN_MEMORY=1` is set the harness has
 * told us not to touch the host's real keychain (the BYOK side already
 * honours this). We return `null` rather than shelling out so the
 * macOS ACL dialog never surfaces during e2e runs.
 */

/**
 * Read the macOS Keychain item `Claude Code-credentials`.
 *
 *   - Returns the password string (the SDK's credentials JSON blob) on
 *     success.
 *   - Returns `null` when the item is absent (`security` exits 44).
 *   - Returns `null` on non-macOS platforms.
 *   - Returns `null` when `CEDARPAD_KEYCHAIN_MEMORY=1` (e2e gate).
 *   - Returns `null` on any other unexpected error, after logging — the
 *     auth probe must stay cheap and side-effect-free.
 */
export function readClaudeCodeKeychain(): string | null {
  if (process.platform !== 'darwin') return null
  if (process.env.CEDARPAD_KEYCHAIN_MEMORY === '1') return null

  const username = process.env.USER
  if (!username) return null

  try {
    const proc = Bun.spawnSync({
      cmd: ['security', 'find-generic-password', '-w', '-s', 'Claude Code-credentials', '-a', username],
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (proc.exitCode === 0) {
      // `-w` prints the password followed by a trailing newline.
      return proc.stdout.toString('utf8').replace(/\n$/, '')
    }
    if (proc.exitCode === 44) {
      // SecKeychain "the specified item could not be found in the keychain"
      return null
    }
    const stderr = proc.stderr.toString('utf8').trim()
    console.error(
      `[cedarpad] Claude Code keychain read failed (exit ${proc.exitCode}): ${stderr}`,
    )
    return null
  } catch (err) {
    console.error('[cedarpad] Claude Code keychain read threw:', err)
    return null
  }
}
