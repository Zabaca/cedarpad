import { vmProvisionModule } from '../../../../vendor/zbc/modules/vm-provision'
import cedarpadWs from './ws'
import cedarpadWsTunnel from './ws-tunnel'

// cloudflared inside cedarpad-ws, running the tunnel cedarpad-ws-tunnel declares.
//
// Fourth marker, after `toolchain`, `app` and `service`, so a tunnel restart is
// not entangled with apt, a repo clone, or the supervisor.
//
// ── This one re-runs on every apply, by design ────────────────────────────
// `volatileEnvFrom` values are excluded from the digest (hashing a value that
// differs every time would rerun apt-get and the whole toolchain on every
// apply) and a non-empty one overrides the digest skip — provision-core's
// `shouldProvision` says so explicitly. So this script runs every time, and it
// is written to be a genuine no-op when nothing moved: the token is compared
// before it is written, the unit is compared before it is installed, and
// cloudflared is restarted only if one of those actually changed or the service
// is not up. A tunnel that bounces on every unrelated apply would drop live
// canvas sync sockets for no reason.
//
// ── Why the token comes through an import ─────────────────────────────────
// A tunnel's run token is derived from the tunnel, and the tunnel is created by
// the instance next door. A copy in secrets.yaml would be a second source of
// truth that goes stale the moment the tunnel is recreated — and unlike the
// API token that mints it, this value is stable for the tunnel's life, so
// nothing would ever notice the drift. `volatileEnvFrom` is the seam that
// exists for exactly this.
export default vmProvisionModule.instance({
  name: 'ws-tunnel-run',
  config: {
    marker: 'tunnel',
    // Pinned to the version this host already runs (agent-tunnel's cloudflared
    // is 2026.7.3). `latest` in a provision script means two machines silently
    // diverge on whichever day each of them last applied.
    env: { CLOUDFLARED_VERSION: '2026.7.3' },
    volatileEnvFrom: { TUNNEL_TOKEN: 'ws-tunnel.runToken' },
    script: `
# --- cloudflared -----------------------------------------------------------
# Version-compared, not merely presence-checked, so bumping the pin above
# actually upgrades the guest instead of being ignored forever.
HAVE=\$(command -v cloudflared >/dev/null 2>&1 && cloudflared --version | awk '{print \$3}' || echo none)
if [ "\$HAVE" != "\$CLOUDFLARED_VERSION" ]; then
  ARCH=\$(dpkg --print-architecture)
  curl -fsSL -o /tmp/cloudflared.deb \\
    "https://github.com/cloudflare/cloudflared/releases/download/\$CLOUDFLARED_VERSION/cloudflared-linux-\$ARCH.deb"
  dpkg -i /tmp/cloudflared.deb
  rm -f /tmp/cloudflared.deb
  echo "[tunnel] cloudflared \$HAVE -> \$CLOUDFLARED_VERSION"
fi

CHANGED=0

# --- the run token ---------------------------------------------------------
# Owned by the service user, not root: cloudflared needs no privilege, and the
# unit below runs as that user for the same reason cedarpad-ws.service does.
ENV_PATH=/etc/cedarpad-ws-tunnel.env
NEW="TUNNEL_TOKEN=\$TUNNEL_TOKEN"
if [ "\$(cat "\$ENV_PATH" 2>/dev/null || true)" != "\$NEW" ]; then
  install -o "\$PROVISION_USER" -g "\$PROVISION_USER" -m 600 /dev/null "\$ENV_PATH"
  printf '%s\\n' "\$NEW" > "\$ENV_PATH"
  chown "\$PROVISION_USER:\$PROVISION_USER" "\$ENV_PATH"
  chmod 600 "\$ENV_PATH"
  CHANGED=1
  echo "[tunnel] run token written"
fi

# --- the unit --------------------------------------------------------------
UNIT_PATH=/etc/systemd/system/cedarpad-ws-tunnel.service
cat > /tmp/cedarpad-ws-tunnel.service <<UNIT
[Unit]
Description=cedarpad workspace tunnel (ws.cedarpad.com)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=\$PROVISION_USER
EnvironmentFile=\$ENV_PATH
ExecStart=/usr/bin/cloudflared --no-autoupdate tunnel run
# Restart always: the tunnel is the only way in, so a cloudflared that stays
# down is the workspace being unreachable with the guest perfectly healthy.
Restart=always
RestartSec=5
# cloudflared is flat at ~37 MB — the same ceiling agent-tunnel.ts uses.
MemoryHigh=192M
MemoryMax=256M

[Install]
WantedBy=multi-user.target
UNIT

if ! cmp -s /tmp/cedarpad-ws-tunnel.service "\$UNIT_PATH"; then
  mv /tmp/cedarpad-ws-tunnel.service "\$UNIT_PATH"
  systemctl daemon-reload
  CHANGED=1
  echo "[tunnel] unit written"
else
  rm -f /tmp/cedarpad-ws-tunnel.service
fi

systemctl enable cedarpad-ws-tunnel.service >/dev/null 2>&1

RESTARTED=0
if [ "\$CHANGED" = 1 ] || ! systemctl is-active --quiet cedarpad-ws-tunnel.service; then
  systemctl restart cedarpad-ws-tunnel.service
  RESTARTED=1
fi

# --- prove it dialled out --------------------------------------------------
# "active" is not the property that matters: cloudflared stays active while it
# retries a token it cannot use, so a unit that is up proves nothing about the
# tunnel being registered at the edge.
if [ "\$RESTARTED" = 1 ]; then
  for i in \$(seq 1 40); do
    if journalctl -u cedarpad-ws-tunnel.service --since "-3 min" --no-pager 2>/dev/null \\
        | grep -qi "Registered tunnel connection"; then
      echo "[tunnel] registered at the edge"
      exit 0
    fi
    sleep 1
  done
  echo "[tunnel] no edge connection registered within 40s" >&2
  systemctl --no-pager --lines=20 status cedarpad-ws-tunnel.service >&2 || true
  journalctl -u cedarpad-ws-tunnel.service --no-pager --lines=40 >&2 || true
  exit 1
fi
echo "[tunnel] unchanged, still active"
`,
  },
  imports: [cedarpadWs, cedarpadWsTunnel],
})
