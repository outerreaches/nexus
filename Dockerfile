FROM node:22-bookworm-slim

ARG HIMALAYA_VERSION=v1.1.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    curl \
    fonts-liberation \
    git \
    jq \
    openssh-client \
    ripgrep \
    tmux \
    wget \
    python3 \
    python3-pip \
    python3-venv \
  && rm -rf /var/lib/apt/lists/*

# Install pinned Himalaya release for the current container architecture.
RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64) target="x86_64-linux" ;; \
    aarch64|arm64) target="aarch64-linux" ;; \
    armv6l) target="armv6l-linux" ;; \
    armv7l) target="armv7l-linux" ;; \
    i386|i686|x86) target="i686-linux" ;; \
    *) echo "Unsupported architecture for Himalaya: $arch" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/himalaya.tgz "https://github.com/pimalaya/himalaya/releases/download/${HIMALAYA_VERSION}/himalaya.${target}.tgz"; \
  tar -xzf /tmp/himalaya.tgz -C /tmp; \
  install -m 0755 /tmp/himalaya /usr/local/bin/himalaya; \
  rm -f /tmp/himalaya /tmp/himalaya.tgz; \
  himalaya --version

# Configure git for container environment (safe.directory for mounted volumes,
# identity for automated commits by coder agents)
RUN git config --global --add safe.directory '*' \
  && git config --global user.email "nexus@local" \
  && git config --global user.name "Nexus"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci
RUN npm install -g excalidraw-to-svg@3.1.0 \
  && command -v excalidraw-to-svg >/dev/null

COPY tsconfig.json tsup.config.ts ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

# Python runtime: PDF/image utilities for creative skills
RUN python3 -m venv /opt/nexus-py \
  && /opt/nexus-py/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/nexus-py/bin/pip install --no-cache-dir \
    pypdf \
    img2pdf Pillow cairosvg

# Make the CLI available on PATH inside the container (so `docker exec ... nexus ...` works)
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/nexus \
  && chmod +x /usr/local/bin/nexus

ENV PATH="/opt/nexus-py/bin:$PATH"
ENV NEXUS_STATE_DIR=/data/nexus
ENV NEXUS_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NEXUS_BROWSER_HEADLESS=1
ENV NEXUS_BROWSER_NO_SANDBOX=1

EXPOSE 18789

ENTRYPOINT ["nexus"]
CMD ["chat"]
