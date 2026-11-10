# The workspace image, in two forms built from ONE base step so they cannot drift:
#
#   container (the default)  the Cloudflare Container under the `durable_object` scheduling policy
#                            (worker/canvas-container.ts). NOT built on cloudflare/sandbox: nothing calls a control
#                            server inside it, the DO starts the container and talks to vite's port directly, so the
#                            image runs the dev stack itself, as its entrypoint. wrangler builds this one (it builds the
#                            last stage, which resolves to this form when IMAGE_KIND is unset).
#   sandbox                  the workspace as an sbx sandbox (scripts/deploy-sandbox.sh builds it with
#                            `--build-arg IMAGE_KIND=sandbox`): the same install, with sbx's in-sandbox daemon as its
#                            first process in place of the stack's start script, the model-route proxy's public certificate,
#                            the release stamps and a vite pre-bundle made at build time.
#
# What the retired sandbox base provided that the stack still uses is replicated in the base step:
#   - bun 1.3.12 (the base's version, so this image changes the runtime around the stack,
#     not the stack's runtime);
#   - node 22, 22.21 or newer: `bun run dev:web` executes vite's `#!/usr/bin/env node` bin with node when
#     node is on PATH, which is how vite has always run in the container;
#   - git, which the Claude Agent SDK shells out to for repository context.
ARG IMAGE_KIND=container

FROM docker.io/library/node:22-bookworm-slim AS node

# sbx's in-sandbox daemon, built from source at a pinned tag and checked against the commit the tag pointed at when it
# was chosen. KEEP IN STEP with the generic sandbox image's (maintained outside this repository): it is the same
# daemon, and the contract is the generic image's (the two ports below). Only the sandbox form uses it.
FROM docker.io/library/golang:1.27.2 AS sandboxd
ARG AGENT_SANDBOX_TAG=v1.0.8
ARG AGENT_SANDBOX_COMMIT=a502928b6eff4a17013d24e9c5481d79e99bcdd5
RUN git clone --quiet --depth 1 --branch "$AGENT_SANDBOX_TAG" https://github.com/kubernetes-sigs/agent-sandbox.git /src \
  && test "$(git -C /src rev-parse HEAD)" = "$AGENT_SANDBOX_COMMIT"
WORKDIR /src
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /sandboxd ./packages/sandboxd/cmd/sandboxd \
  && /sandboxd --version

# --- the shared base step: everything both forms run
FROM docker.io/oven/bun:1.3.12 AS base

COPY --from=node /usr/local/bin/node /usr/local/bin/node

# The floor is 22.21, not a pin. `NODE_USE_ENV_PROXY`, which sbx sets so node's fetch and https use its egress proxy,
# exists from node 22.21.0; below it vite's calls to the platform's origin fail in a sandbox, which has no DNS.
RUN v="$(node --version)" \
  && node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major === 22 && minor >= 21 ? 0 : 1)' \
  || { echo "node ${v} is not 22.21 or newer" >&2; exit 1; }

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

# --- the Cloudflare Container
FROM base AS image-container
# exec form, so container-start.ts is PID 1 and receives the SIGTERM the DO's idle stop
# sends; it takes the dev stack down with it (scripts/container-start.ts `down`).
ENTRYPOINT ["bun", "scripts/container-start.ts"]

# --- the sbx sandbox
FROM base AS image-sandbox
COPY --from=sandboxd /sandboxd /usr/local/bin/sandboxd

# The proxy's certificate: the agent's api.anthropic.com traffic is passed on by sbx to the model-route proxy, which
# presents a leaf this CA signed. The sandbox's stored environment names this path (sandbox/workspace.env).
RUN install -D -m 644 sandbox/claude-proxy-ca.crt /etc/cedarpad/claude-proxy-ca.crt

# The release stamps, as deploy.sh writes them for the container and the VM's app step wrote them for the VM
# (ADR-0025): bridge.ts reads both out of server/ and answers `dev` when they are absent. They are gitignored, so
# the archive this image is built from has none; the deploy passes the commit and the version.
ARG BUILD_REV
ARG BUILD_VERSION
RUN test -n "$BUILD_REV" && test -n "$BUILD_VERSION" \
  && printf '%s' "$BUILD_REV" > server/build-rev.txt \
  && printf '%s' "$BUILD_VERSION" > server/version.txt

# vite's pre-bundle, made now (scripts/prebundle.ts says why).
RUN bun scripts/prebundle.ts

# sandboxd's two ports are moved well away from where a dev server would bind (8080, 3000, 5173...); the allocator
# dials them. /workspace is its root dir and where the sandbox's commands start. root, inside gVisor: the sandbox is the
# whole machine, and gVisor and the network policy are the walls, not the user inside.
RUN mkdir -p /workspace
WORKDIR /workspace
EXPOSE 49982 49983
ENTRYPOINT ["/usr/local/bin/sandboxd", "--root-dir=/workspace", "--grpc-port=49982", "--rest-port=49983"]

# The form wrangler builds is the last stage: the container's, unless IMAGE_KIND says otherwise.
FROM image-${IMAGE_KIND}
