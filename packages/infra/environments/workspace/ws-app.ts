import { vmProvisionModule } from '../../../../vendor/zbc/modules/vm-provision'
import cedarpadWs from './ws'

// The app half of cedarpad-ws: the checkout and its installed dependencies.
// Separate instance, separate marker from cedarpad-ws-provision, so bumping the
// toolchain and redeploying the app are independent digests — neither drags the
// other's apt-get or `bun install` along.
//
// ── Why /app/agent-canvas and not somewhere friendlier ──────────────────────
// That path is CANVAS_CONTAINER_CWD (packages/canvas/worker/container-env.ts),
// the cwd the Cloudflare container runs under. It is not cosmetic: the Claude
// Agent SDK encodes the cwd into the on-disk project-dir name, so a session
// written under one cwd and resumed under another is orphaned by name ("No
// conversation found"). Matching it means the Worker's injected CANVAS_CWD is
// correct here unchanged, and a workspace can move between the container and
// this guest without losing conversation continuity.
//
// ── The token never rests on disk ───────────────────────────────────────────
// GITHUB_PAT reaches the script as an env var and is embedded in the remote URL
// only for the duration of a clone/fetch, then scrubbed back to the public URL —
// the same discipline packages/canvas/server/repo-checkout.ts applies to the
// bridge's own checkouts. A token left in .git/config is a token that outlives
// every rotation.
//
// The PAT is hashed into the provision digest along with the rest of `env`, so
// rotating it re-runs this provision. That is the desired behaviour, not a wart:
// a rotated credential should re-converge the thing that used it.
//
// ── BRANCH is `main`, and was `self-hosted-workspace` for three days ────────
// When this instance was written on 2026-08-14, `scripts/ws-supervisor.ts` — the
// process cedarpad-ws.service runs — existed only on `self-hosted-workspace`, so
// pinning main would have deployed a checkout with no supervisor in it. That
// stopped being true the same afternoon: main continued directly from the
// branch's tip (dc18f1b), and by 2026-08-17 the branch was 0 commits ahead of
// main and 8 behind, fully merged, its ref never advanced again.
//
// The cost of not noticing was not abstract. Two of those eight — 513aba4, on a
// tunnel reporting "not serving" differently than the sandbox proxy does, and
// 50f4e45, on a question about the container being answered by the container —
// are fixes written FOR this deployment, and the guest was running the code they
// were written against. A pin to a feature branch is a pin to the moment the
// feature was unmerged; it does not expire on its own, and the surface it
// silently withholds is the one most likely to be fixing this exact host.
//
// Pinning a branch again is legitimate for the same reason it was the first
// time — unmerged work this guest needs. Write the date and the reason here when
// you do, and treat the pin as a debt to unwind, not a setting.
export default vmProvisionModule.instance({
  name: 'ws-app',
  config: {
    marker: 'app',
    // A digest cannot express a moving target, and this provision's whole job is
    // to be at the current commit. {packages, script, env} are all constant here,
    // so the marker always matched and the fetch-and-reset below never ran: the
    // guest sat on 71afd0c, stamped 2026-08-20, while origin/main moved six
    // commits on, and three applies on 2026-08-22 each reported `unchanged`.
    // BRANCH: 'main' above described an intention the mechanism could not carry
    // out. The note further up treats a branch pin as the hazard; a frozen digest
    // is the same hazard without a branch name to give it away.
    force: true,
    envSecrets: { GIT_TOKEN: 'GITHUB_PAT' },
    env: { REPO: 'Zabaca/cedarpad', BRANCH: 'main', ROOT: '/app/agent-canvas' },
    script: `
AUTHED="https://x-access-token:\$GIT_TOKEN@github.com/\$REPO.git"
PUBLIC="https://github.com/\$REPO.git"

# --- checkout --------------------------------------------------------------
# Full clone, not --depth 1: the dev-agent builds worktrees off this checkout
# (packages/canvas/server/repo-worktree.ts) and a shallow history makes branch
# work fail in ways that surface far from here.
if [ ! -d "\$ROOT/.git" ]; then
  mkdir -p "\$(dirname "\$ROOT")"
  git clone "\$AUTHED" "\$ROOT"
else
  git -C "\$ROOT" remote set-url origin "\$AUTHED"
  git -C "\$ROOT" fetch origin "\$BRANCH"
fi
git -C "\$ROOT" checkout -B "\$BRANCH" "origin/\$BRANCH"
git -C "\$ROOT" reset --hard "origin/\$BRANCH"
# Scrub the credential back out of .git/config before anything else can read it.
git -C "\$ROOT" remote set-url origin "\$PUBLIC"
git config --system --add safe.directory "\$ROOT"
chown -R "\$PROVISION_USER:\$PROVISION_USER" "\$(dirname "\$ROOT")"

echo "[app] checked out \$(git -C "\$ROOT" rev-parse --short HEAD)"

# --- stamps ----------------------------------------------------------------
# The same two the container's deploy.sh writes, for the same reason (cedarpad
# ADR-0025): the SHA is the operational truth and the version is the
# communication truth, and \`bridge.ts\` reads both out of its own directory,
# answering \`dev\` when they are absent. They are gitignored, so a checkout
# alone leaves this Guest unable to say what it is running — which made the
# workspace the one surface a release could not verify.
#
# Written from the checkout rather than passed in: this provision IS the thing
# that decided which commit is here, so anything else would be a second opinion
# about it. The version comes from the ROOT package.json, as deploy.sh reads it
# — one product version per release, and the per-package 0.0.1s stay private.
STAMP_DIR="\$ROOT/packages/canvas/server"
git -C "\$ROOT" rev-parse --short HEAD | tr -d '\\n' > "\$STAMP_DIR/build-rev.txt"
python3 -c "import json; print(json.load(open('\$ROOT/package.json'))['version'], end='')" > "\$STAMP_DIR/version.txt"
echo "[app] stamped \$(cat "\$STAMP_DIR/build-rev.txt") / v\$(cat "\$STAMP_DIR/version.txt")"

# --- dependencies ----------------------------------------------------------
# --frozen-lockfile with a plain fallback, matching packages/canvas/Dockerfile:
# the image excludes packages/app from the workspace, so a frozen install can
# legitimately fail on a lockfile that mentions it.
runuser -l "\$PROVISION_USER" -c "cd \$ROOT && bun install --frozen-lockfile || bun install"

# --- pty-server ------------------------------------------------------------
# npm, NOT bun, and not optional-by-accident: bun install cannot build node-pty,
# so pty-server is its own npm-installed island (see its README). scripts/dev.ts
# degrades to no Console when this is missing rather than crash-looping, so a
# failure here is a warning, not a failed apply.
if ! runuser -l "\$PROVISION_USER" -c "cd \$ROOT/packages/canvas/pty-server && npm install --no-audit --no-fund"; then
  echo "[app] WARNING: pty-server npm install failed — the Console will be absent"
fi
`,
  },
  imports: [cedarpadWs],
})
