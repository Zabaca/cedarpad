import { vmProvisionModule } from '../../../../vendor/zbc/modules/vm-provision'
import cedarpadWs from './ws'

// The toolchain half of cedarpad-ws: everything the canvas stack needs to EXIST
// on the guest, and nothing about the app itself. The checkout, its env and the
// service unit are a separate provision instance under its own marker, so a
// toolchain bump and an app redeploy are independent digests and neither drags
// the other's work along.
//
// ── This file mirrors packages/canvas/Dockerfile in the cedarpad repo ────────
// That Dockerfile is the source of truth for what the Cloudflare container
// carries, and this is the second expression of the same list. THEY CAN DRIFT,
// silently, and the failure that drift produces is "works in prod, breaks here"
// (or worse, the reverse). If you change a version here, change it there in the
// same commit.
//
// Deliberately ABSENT, unlike the Dockerfile: the `cloudflare/sandbox` base image
// and its /container-server control plane. Nothing outside Cloudflare invokes it,
// and the guest runs `scripts/dev.ts` directly under systemd.
export default vmProvisionModule.instance({
  name: 'ws-provision',
  config: {
    marker: 'toolchain',
    packages: [
      'build-essential', // node-gyp, for pty-server's node-pty native build
      'ca-certificates',
      'curl',
      'git',
      'gnupg',
      'jq',
      'python3', // also node-gyp
      'ripgrep',
      'wget',
    ],
    script: `
# --- node + npm ------------------------------------------------------------
# For pty-server ONLY (ADR-0021's Console). node-pty is completely non-functional
# under bun — zero bytes, EBADF on resize, measured across two bun versions and
# two platforms — so scripts/dev.ts spawns it with \`node\` on purpose. Ubuntu's
# own nodejs is too old to build current node-pty; NodeSource 22 LTS is.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# --- bun -------------------------------------------------------------------
# Per-user, like agent-vm-provision: bun installs into \$HOME and does not belong
# to root. runuser -l also drops any exported secrets from this script.
cat > /tmp/cedarpad-setup.sh <<'SETUP'
set -euo pipefail
if [ ! -x "$HOME/.bun/bin/bun" ]; then
  curl -fsSL https://bun.sh/install | bash
fi
SETUP
chmod 755 /tmp/cedarpad-setup.sh
runuser -l "\$PROVISION_USER" -c 'bash /tmp/cedarpad-setup.sh'
rm -f /tmp/cedarpad-setup.sh

# systemd units and non-interactive ssh never source .bashrc (Ubuntu's returns
# early unless the shell is interactive), so a PATH line there is invisible to
# both. /usr/local/bin is on the default PATH for every shell and every unit.
for b in bun bunx; do
  ln -sfn "\$PROVISION_HOME/.bun/bin/\$b" "/usr/local/bin/\$b"
done
`,
  },
  imports: [cedarpadWs],
})
