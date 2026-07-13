# syntax=docker/dockerfile:1

FROM node:22.23.1-bookworm-slim AS builder

ARG TARGETARCH
ARG BUN_VERSION=1.3.14

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl unzip python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) asset=bun-linux-x64-baseline.zip; sha=a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7 ;; \
      arm64) asset=bun-linux-aarch64.zip; sha=a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b ;; \
      *) printf 'unsupported Docker architecture: %s\n' "$TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --proto '=https' \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}" \
      -o /tmp/bun.zip; \
    printf '%s  %s\n' "$sha" /tmp/bun.zip | sha256sum -c -; \
    unzip -q /tmp/bun.zip -d /tmp/bun; \
    install -m 0755 "/tmp/bun/${asset%.zip}/bun" /usr/local/bin/bun; \
    bun --version | grep -Fx "$BUN_VERSION"; \
    rm -rf /tmp/bun /tmp/bun.zip

WORKDIR /opt/desk
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build:distribution \
    && test -x dist/cli/main.js \
    && test -x libexec/desk-standalone

FROM node:22.23.1-bookworm-slim AS runtime

ARG CLAUDE_VERSION=2.1.177
ARG CODEX_VERSION=0.139.0

ENV DEBIAN_FRONTEND=noninteractive \
    IS_SANDBOX=1 \
    PATH="/root/.local/bin:${PATH}" \
    TERM=xterm-256color

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl gnupg git tmux ripgrep procps less gawk tar \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN CODEX_NON_INTERACTIVE=1 CODEX_RELEASE="${CODEX_VERSION}" \
      sh -c "$(curl -fsSL https://chatgpt.com/codex/install.sh)" \
    && ln -sf /root/.local/bin/codex /usr/local/bin/codex \
    && codex --version

RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_VERSION}" \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version

COPY --from=builder /opt/desk /opt/desk
RUN ln -s /opt/desk/dist/cli/main.js /usr/local/bin/desk \
    && desk help >/dev/null \
    && test -x /opt/desk/libexec/desk-standalone

WORKDIR /workspace
EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:5173/ >/dev/null || exit 1

# SECURITY: Desk has no authentication and grants filesystem, terminal, and Git
# access. Bind it only to a trusted interface, tunnel, or authenticated proxy.
ENTRYPOINT ["desk"]
CMD ["serve", "--host", "0.0.0.0", "--port", "5173"]
