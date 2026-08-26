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
//
// ⚠️ BUT APPLYING THIS INSTANCE STOPS THE CANVAS. The paragraph above is about
// what a restart INTERRUPTS; vite is the supervisor's CHILD, so a restart also
// KILLS it, and the stack stays down until cedarpad's edge Worker pushes an
// environment again — the same cold state as after a reboot, and unreachable from
// here because this guest holds no credential to boot with. Verified the hard way
// on 2026-08-23. So an apply of `ws-service` is never routine: it is a deliberate
// act with a cold canvas on the other side of it, recovered by the next real
// request. `ws-supervisor.ts`'s header carries the mechanism.
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
answered=
for i in \$(seq 1 20); do
  if curl -fsS "http://127.0.0.1:\$SUP_PORT/__status" >/dev/null 2>&1; then
    echo "[service] supervisor answering on \$SUP_PORT"
    answered=1
    break
  fi
  sleep 1
done

# \`break\`, never \`exit 0\`. vm-provision appends its marker write AFTER this
# script and relies on \`set -e\` to skip it on failure — so a success path that
# exits takes the marker with it. This provision ran on every single apply from
# 2026-08-14 to 2026-08-22, restarting the live supervisor each time and
# reporting "provisioned" each time, because \`exit 0\` never let the marker land.
if [ -z "\$answered" ]; then
  echo "[service] supervisor did NOT answer on \$SUP_PORT" >&2
  systemctl --no-pager --lines=20 status cedarpad-ws.service >&2 || true
  exit 1
fi
`,
  },
  imports: [cedarpadWs],
})
