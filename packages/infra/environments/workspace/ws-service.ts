import { vmProvisionModule } from '../../../../vendor/zbc/modules/vm-provision'
import cedarpadWs from './ws'

// The unit that runs the workspace supervisor inside cedarpad-ws.
//
// Third marker, after `toolchain` and `app`, so restarting the service is not
// entangled with re-cloning the repo or re-running apt.
//
// ── What this unit does NOT start ───────────────────────────────────────────
// It starts the SUPERVISOR, not the canvas. The supervisor holds the dev stack
// down until cedarpad's edge Worker pushes the environment it already owns
// (packages/canvas/worker/container-env.ts), so no R2 key, no agent OAuth token
// and no BETTER_AUTH_SECRET ever rests on this guest. That is the whole reason
// the supervisor exists — a unit that started `dev.ts` directly would need those
// values on disk and would leave cedarpad worse off than the Cloudflare container
// it is replacing.
//
// WS_SUPERVISOR_TOKEN is the one secret that DOES rest here, and it is a
// different kind of thing: a shared bearer minted for this seam alone, not a
// copy of a production credential. Cloudflare Access already gates the hostname
// with a service token; this is the second belt, checked by the process that
// would actually run the command.
//
// Port 4599 is control plane only. cloudflared routes /__boot and /__status here
// and everything else straight to vite on 4510, so the chat SSE stream and the
// canvas sync websocket never pass through the supervisor — restarting it cannot
// drop a live stream.
export default vmProvisionModule.instance({
  name: 'ws-service',
  config: {
    marker: 'service',
    envSecrets: { SUP_TOKEN: 'WS_SUPERVISOR_TOKEN' },
    env: { CWD: '/app/agent-canvas/packages/canvas', SUP_PORT: '4599', VITE_PORT: '4510' },
    script: `
# The bearer, readable only by the service user. Written before the unit so a
# restart never races an absent EnvironmentFile.
install -o "\$PROVISION_USER" -g "\$PROVISION_USER" -m 600 /dev/null /etc/cedarpad-ws.env
printf 'WS_SUPERVISOR_TOKEN=%s\\n' "\$SUP_TOKEN" > /etc/cedarpad-ws.env
chown "\$PROVISION_USER:\$PROVISION_USER" /etc/cedarpad-ws.env
chmod 600 /etc/cedarpad-ws.env

cat > /etc/systemd/system/cedarpad-ws.service <<UNIT
[Unit]
Description=cedarpad workspace supervisor (control plane for the canvas dev stack)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=\$PROVISION_USER
WorkingDirectory=\$CWD
EnvironmentFile=/etc/cedarpad-ws.env
Environment=WS_CANVAS_CWD=\$CWD
Environment=WS_SUPERVISOR_PORT=\$SUP_PORT
Environment=WS_VITE_PORT=\$VITE_PORT
ExecStart=/usr/local/bin/bun run scripts/ws-supervisor.ts
# Restart always: the supervisor holding no state means a restart is free, and it
# coming back is what lets the next Worker request re-push and recover.
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable cedarpad-ws.service >/dev/null 2>&1
systemctl restart cedarpad-ws.service

# Prove it is actually listening rather than merely "started" — systemd calls a
# process that exits immediately a success right up until Restart= gives up.
for i in \$(seq 1 20); do
  if curl -fsS "http://127.0.0.1:\$SUP_PORT/__status" >/dev/null 2>&1; then
    echo "[service] supervisor answering on \$SUP_PORT"
    exit 0
  fi
  sleep 1
done
echo "[service] supervisor did NOT answer on \$SUP_PORT" >&2
systemctl --no-pager --lines=20 status cedarpad-ws.service >&2 || true
exit 1
`,
  },
  imports: [cedarpadWs],
})
