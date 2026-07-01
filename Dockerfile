# syntax=docker/dockerfile:1
#
# Desk — STANDALONE (Bun single-binary) image. Based on ./Dockerfile.
#
# The runtime ships NO Node.js. `npm run build:standalone` compiles one
# self-contained `desk-server` binary that embeds the Bun runtime, the Vite UI
# bundle, node-pty's pty.node, and the TypeScript/Python language servers. The
# runtime stage therefore carries only the EXTERNAL programs desk shells out to —
# tmux, git, gh, ripgrep, and the agent CLIs (Codex, Claude Code).
#
# Build:  docker build -t desk:standalone .
# Run:    docker run --rm -p 5173:5173 desk:standalone   # http://127.0.0.1:5173

##################################
# Stage 1 — build + compile binary
##################################
FROM node:22-bookworm-slim AS builder

# node-pty native addon (python3 + toolchain) + ca-certificates for the bun
# installer's HTTPS download (the slim base ships none).
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 make g++ curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bun provides `bun build --compile`.
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# build:standalone = vite build (UI) → make-assets (tar UI+LSP) → bun --compile.
# The UI build can overflow node's ~2 GB default heap.
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build:standalone \
    && test -s desk-server

##################################
# Stage 2 — runtime image (NO node)
##################################
FROM debian:bookworm-slim AS runtime

# Exact client versions (2026-06-13):
#   Claude Code  latest = 2.1.177  ·  stable = 2.1.153
#   Codex CLI    latest stable = 0.139.0
ARG CLAUDE_VERSION=2.1.177
ARG CODEX_VERSION=0.139.0

# IS_SANDBOX=1: this image runs desk as root; Claude Code refuses
# `--dangerously-skip-permissions` (a session's bypassPermissions) as root unless
# the env marks a sandbox — without it bypass-permission claude sessions die on
# launch. A desk container is a dedicated, isolated environment.
ENV DEBIAN_FRONTEND=noninteractive \
    IS_SANDBOX=1 \
    PATH="/root/.local/bin:${PATH}" \
    DESK_HOST=0.0.0.0 \
    DESK_PORT=5173 \
    TERM=xterm-256color

# Runtime system tooling (same roles as the Node image):
#   tmux — durable runtime that owns every agent session; git/gh — git+Projects;
#   ripgrep — fs/content search; procps — `ps` for the kill switch;
#   tar — extracts the embedded UI/LSP tarballs on first use;
#   gawk — codex installer needs interval-regex (mawk lacks it).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git tmux ripgrep procps less gawk tar \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# --- Codex CLI (native Rust binary, pinned) --------------------------------
# CODEX_NON_INTERACTIVE only here, scoped to the install script (no TTY during
# build) — NOT a persistent ENV: codex runs as an interactive TUI in desk sessions.
RUN CODEX_NON_INTERACTIVE=1 CODEX_RELEASE="${CODEX_VERSION}" sh -c "$(curl -fsSL https://chatgpt.com/codex/install.sh)" \
    && ln -sf /root/.local/bin/codex /usr/local/bin/codex \
    && codex --version

# --- Claude Code (native binary, pinned) -----------------------------------
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version

# Just the self-contained binary: UI + LSP servers are embedded; terminals use
# Bun's native PTY (Bun.Terminal), so there's no node-pty native to ship.
COPY --from=builder /app/desk-server /usr/local/bin/desk-server

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:5173/ >/dev/null || exit 1

# SECURITY: Desk has NO authentication and grants full fs/terminal/git access to
# anyone who reaches the port. Only expose it behind a trusted tunnel/proxy.
CMD ["desk-server"]
