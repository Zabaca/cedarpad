# The workspace container under the `durable_object` scheduling policy
# (worker/canvas-container.ts). It is NOT built on cloudflare/sandbox: nothing calls a
# control server inside it, the DO starts the container and talks to vite's port directly.
# So the image runs the dev stack itself, as its entrypoint.
#
# What the retired sandbox base provided that the stack still uses is replicated here:
#   - bun 1.3.12 (the base's version, so this image changes the runtime around the stack,
#     not the stack's runtime);
#   - node 22: `bun run dev:web` executes vite's `#!/usr/bin/env node` bin with node when
#     node is on PATH, which is how vite has always run in the container;
#   - git, which the Claude Agent SDK shells out to for repository context.
FROM docker.io/library/node:22-bookworm-slim AS node

FROM docker.io/oven/bun:1.3.12

COPY --from=node /usr/local/bin/node /usr/local/bin/node

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Manifests, install, THEN source, so a code-only change never re-runs the install. The build context is the repo root (wrangler.jsonc
# `build_context: "../.."`).
WORKDIR /app/agent-canvas
COPY package.json bun.lock tsconfig.json ./
COPY packages/canvas/package.json packages/canvas/
RUN bun install --frozen-lockfile || bun install
COPY packages/canvas packages/canvas
COPY packages/infra packages/infra

# The runtime authority for both is the env the DO starts the container with
# (worker/container-env.ts); these are matching image defaults.
ENV CANVAS_CWD=/app/agent-canvas/packages/canvas
# The chat agent runs with bypassPermissions, which Claude Code refuses as root unless
# IS_SANDBOX is set. The container is the isolation boundary.
ENV IS_SANDBOX=1

WORKDIR /app/agent-canvas/packages/canvas
# exec form, so container-start.ts is PID 1 and receives the SIGTERM the DO's idle stop
# sends; it takes the dev stack down with it (scripts/container-start.ts `down`).
ENTRYPOINT ["bun", "scripts/container-start.ts"]
