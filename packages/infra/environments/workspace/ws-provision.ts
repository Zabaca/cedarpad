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
// (or worse, the reverse). The pinned pieces are pinned for reasons that live in
// the Dockerfile's own comments — duckdb in particular is matched to the
// warehouse container's on-disk/parquet format, so bumping it on one side only
// produces files the other side cannot read. If you change a version here, change
// it there in the same commit.
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
      'unzip', // the duckdb release is a zip
      'wget',
    ],
    script: `
# --- gh (GitHub CLI) -------------------------------------------------------
# The dev-agent's open_pr shells out to \`gh pr create\`. Unpinned, matching the
# Dockerfile, which pins no apt package either.
if ! command -v gh >/dev/null 2>&1; then
  mkdir -p -m 755 /etc/apt/keyrings
  wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg \\
    https://cli.github.com/packages/githubcli-archive-keyring.gpg
  chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
  mkdir -p -m 755 /etc/apt/sources.list.d
  echo "deb [arch=\$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq gh
fi

# --- node + npm ------------------------------------------------------------
# For pty-server ONLY (ADR-0021's Console). node-pty is completely non-functional
# under bun — zero bytes, EBADF on resize, measured across two bun versions and
# two platforms — so scripts/dev.ts spawns it with \`node\` on purpose. Ubuntu's
# own nodejs is too old to build current node-pty; NodeSource 22 LTS is.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

# --- duckdb CLI ------------------------------------------------------------
# PINNED, and the pin is load-bearing: it must match the duckdb the warehouse
# container runs (packages/canvas/Dockerfile.warehouse) so the CLI and the
# pipeline read the identical on-disk/parquet format.
DUCKDB_VERSION=1.5.5
if [ "\$(duckdb --version 2>/dev/null | grep -o "v\$DUCKDB_VERSION" || true)" != "v\$DUCKDB_VERSION" ]; then
  ARCH=\$(dpkg --print-architecture)
  case "\$ARCH" in
    amd64) DUCKDB_ARCH=linux-amd64 ;;
    arm64) DUCKDB_ARCH=linux-arm64 ;;
    *) echo "unsupported arch: \$ARCH" >&2; exit 1 ;;
  esac
  wget -nv -O /tmp/duckdb.zip \\
    "https://github.com/duckdb/duckdb/releases/download/v\$DUCKDB_VERSION/duckdb_cli-\$DUCKDB_ARCH.zip"
  unzip -o /tmp/duckdb.zip -d /usr/local/bin
  rm -f /tmp/duckdb.zip
  chmod +x /usr/local/bin/duckdb
fi

# --- git identity ----------------------------------------------------------
# repo-worktree.ts's commit() runs plain \`git commit\` with no -c user.name and
# no author env, so identity has to exist somewhere. System-level, so it applies
# whichever user the stack runs as.
git config --system user.name "cedarpad-dev-agent"
git config --system user.email "dev-agent@cedarpad.local"

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
