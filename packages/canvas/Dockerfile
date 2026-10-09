# agent-canvas container: the @cloudflare/sandbox base (node 24 + the
# container-control server) + bun + the package with node_modules baked in, so a
# cold boot is just "start the dev stack", not "install". The base image's
# /container-server entrypoint MUST stay — the Worker starts our stack via
# startProcess (scripts/container-start.ts). Do NOT add ENTRYPOINT/CMD.
# Pinned to the same tag as the @cloudflare/sandbox SDK version in package.json.
FROM docker.io/cloudflare/sandbox:0.12.1

# bun (the runtime for the bridge + vite) ships in the base image at
# /usr/local/bin/bun, so no install step is needed.

# gh (GitHub CLI) — the dev-agent's `open_pr` tool shells out to `gh pr create`
# (server/repo-worktree.ts) after committing + pushing. Installed from the official apt
# repo (base image is Ubuntu 22.04/jammy), unpinned like the rest of apt's packages here —
# not a version download, since nothing else in this Dockerfile pins apt package versions.
# Placed before the bun-install layer below (and touches no files copied by it) so it stays
# cached across code-only deploys (commit 902f17e) and only re-runs if this RUN changes.
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && wget -nv -O /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && mkdir -p -m 755 /etc/apt/sources.list.d \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

# DuckDB CLI (~50 MB) — ADR-0017: chat turns can query the workspace warehouse's marts
# (R2 parquet) directly via `duckdb`. Deliberately CLI-only, no python — the Python
# transform toolchain (dbt-duckdb, dlt) lives ONLY in the separate warehouse container
# (Dockerfile.warehouse) so this image's cold-boot path (every chat turn) doesn't carry
# it. Pinned so its on-disk format matches the warehouse container's duckdb.
RUN ARCH=$(dpkg --print-architecture) \
  && case "$ARCH" in \
       amd64) DUCKDB_ARCH=linux-amd64 ;; \
       arm64) DUCKDB_ARCH=linux-arm64 ;; \
       *) echo "unsupported arch: $ARCH" >&2 && exit 1 ;; \
     esac \
  && wget -nv -O /tmp/duckdb.zip "https://github.com/duckdb/duckdb/releases/download/v1.5.5/duckdb_cli-${DUCKDB_ARCH}.zip" \
  && apt-get update && apt-get install -y --no-install-recommends unzip && rm -rf /var/lib/apt/lists/* \
  && unzip -o /tmp/duckdb.zip -d /usr/local/bin \
  && rm /tmp/duckdb.zip \
  && chmod +x /usr/local/bin/duckdb

# Default git identity for dev-agent commits: repo-worktree.ts's `commit()` runs plain
# `git commit` with no `-c user.name`/`user.email` or author env, so it needs identity
# configured somewhere — system-level here so it's present regardless of which user the
# container process runs as.
RUN git config --system user.name "cedarpad-dev-agent" \
  && git config --system user.email "dev-agent@cedarpad.local"

# Build context is the REPO ROOT (wrangler.jsonc `image_build_context: "../.."`), so
# we bake the workspace — root manifest + lockfile + the packages the canvas instance
# needs. web-poc now lives in-tree at packages/canvas/web-poc (imported by relative
# path, mounted into the canvas app + served in the same bridge process), so it is
# copied with packages/canvas — no separate copy. `bun install` also links
# @cedarpad/infra (a root dependency). The dev stack is vite (not a static
# build), so node_modules is installed here, not baked.
WORKDIR /app/agent-canvas
# Root tsconfig.json is required at runtime too: web-poc/tsconfig.json extends it
# (../../../tsconfig.json), and vite/esbuild resolves that per-file when it transforms
# web-poc/src/*.tsx. Without it the dev server errors "failed to resolve extends".
#
# LAYER CACHING (deploy speed): copy ONLY the manifests bun install reads, install, THEN copy the
# source. `bun install` reads package.json/bun.lock — never the .ts source — so the (slow) install
# layer is cached across code-only deploys and only re-runs when a manifest or the lockfile changes.
# Copy just the canvas + infra member manifests. web-poc isn't a workspace member; its deps
# live in packages/canvas/package.json, so that one manifest is enough for the install graph.
COPY package.json bun.lock tsconfig.json ./
COPY packages/canvas/package.json packages/canvas/
# `packages/infra` has no package.json since fc4f0da retired @cedarpad/infra — the
# engine comes from vendor/zbc now. Copying a manifest that does not exist failed the
# 0.2.5 build at this line; it was the first deploy after that commit, so nothing had
# exercised it in between.
RUN bun install --frozen-lockfile || bun install
# Source AFTER install — a change here can't bust the cached install layer above. .dockerignore
# strips **/node_modules from the context, so this can't clobber the install layer's node_modules.
COPY packages/canvas packages/canvas
COPY packages/infra packages/infra

# The canvas package is the app root at runtime (vite + bridge + the agent's authored
# components); the overlay watcher and vite read from here. This is a matching image
# default — the runtime authority is CANVAS_CONTAINER_CWD (worker/container-env.ts),
# injected into the container env at spawn so the value can't drift (#133). Keep the two
# in sync if this path ever moves.
ENV CANVAS_CWD=/app/agent-canvas/packages/canvas

# The canvas chat is a full Claude Code agent run with bypassPermissions (which
# passes --dangerously-skip-permissions). Claude Code refuses that as root unless
# IS_SANDBOX is set; this container IS the isolation boundary (ephemeral, network
# gated by the Worker), so declare it so the agent can run.
ENV IS_SANDBOX=1
