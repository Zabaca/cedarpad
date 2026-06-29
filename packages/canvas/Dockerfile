# agent-canvas container: the @cloudflare/sandbox base (node 24 + the
# container-control server) + bun + the package with node_modules baked in, so a
# cold boot is just "start the dev stack", not "install". The base image's
# /container-server entrypoint MUST stay — the Worker starts our stack via
# startProcess (scripts/container-start.ts). Do NOT add ENTRYPOINT/CMD.
# Pinned to the same tag as the @cloudflare/sandbox SDK version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.1

# bun (the runtime for the bridge + vite) ships in the base image at
# /usr/local/bin/bun, so no install step is needed.

# Bake the package + its node_modules (the dev stack is vite, not a static build).
WORKDIR /app/agent-canvas
COPY . /app/agent-canvas
RUN bun install --frozen-lockfile || bun install

# The agent authors components here; the overlay watcher and vite both read it.
ENV CANVAS_CWD=/app/agent-canvas

# The canvas chat is a full Claude Code agent run with bypassPermissions (which
# passes --dangerously-skip-permissions). Claude Code refuses that as root unless
# IS_SANDBOX is set; this container IS the isolation boundary (ephemeral, network
# gated by the Worker), so declare it so the agent can run.
ENV IS_SANDBOX=1
