# agent-canvas container: the @cloudflare/sandbox base (node 24 + the
# container-control server) + bun + the package with node_modules baked in, so a
# cold boot is just "start the dev stack", not "install". The base image's
# /container-server entrypoint MUST stay — the Worker starts our stack via
# startProcess (scripts/container-start.ts). Do NOT add ENTRYPOINT/CMD.
# Pinned to the same tag as the @cloudflare/sandbox SDK version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.1

# bun (the runtime for the bridge + vite) ships in the base image at
# /usr/local/bin/bun, so no install step is needed.

# Build context is the REPO ROOT (wrangler.jsonc `image_build_context: "../.."`), so
# we bake the workspace — root manifest + lockfile + the packages the canvas instance
# needs. web-poc now lives in-tree at packages/canvas/web-poc (imported by relative
# path, mounted into the canvas app + served in the same bridge process), so it is
# copied with packages/canvas — no separate copy. `bun install` also links
# @cedarpad/infra (a root dependency). packages/app (the separate desktop app) is
# excluded via the repo-root .dockerignore. The dev stack is vite (not a static
# build), so node_modules is installed here, not baked.
WORKDIR /app/agent-canvas
COPY package.json bun.lock ./
COPY packages/canvas packages/canvas
COPY packages/infra packages/infra
RUN bun install --frozen-lockfile || bun install

# The canvas package is the app root at runtime (vite + bridge + the agent's authored
# components); the overlay watcher and vite read from here.
ENV CANVAS_CWD=/app/agent-canvas/packages/canvas

# The canvas chat is a full Claude Code agent run with bypassPermissions (which
# passes --dangerously-skip-permissions). Claude Code refuses that as root unless
# IS_SANDBOX is set; this container IS the isolation boundary (ephemeral, network
# gated by the Worker), so declare it so the agent can run.
ENV IS_SANDBOX=1
