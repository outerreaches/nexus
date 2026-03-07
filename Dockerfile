FROM node:22-bookworm-slim

ARG HIMALAYA_VERSION=v1.1.0
ARG NIKTO_VERSION=2.6.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    curl \
    dnsutils \
    fonts-liberation \
    git \
    jq \
    libio-socket-ssl-perl \
    libnet-ssleay-perl \
    nmap \
    openssh-client \
    perl \
    ripgrep \
    tmux \
    wget \
    whois \
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

# Install pinned Nikto release from upstream GitHub archive.
RUN set -eux; \
  mkdir -p /opt/nikto; \
  curl -fsSL -o /tmp/nikto.tar.gz "https://github.com/sullo/nikto/archive/refs/tags/${NIKTO_VERSION}.tar.gz"; \
  tar -xzf /tmp/nikto.tar.gz -C /opt/nikto --strip-components=1; \
  printf '%s\n' '#!/bin/sh' 'exec perl /opt/nikto/program/nikto.pl "$@"' > /usr/local/bin/nikto; \
  chmod +x /usr/local/bin/nikto; \
  nikto -Version >/dev/null 2>&1; \
  rm -f /tmp/nikto.tar.gz

# Security recon tools (ProjectDiscovery + ffuf) — pre-built Go binaries.
ARG SUBFINDER_VERSION=v2.7.1
ARG HTTPX_VERSION=v1.6.10
ARG NUCLEI_VERSION=v3.3.7
ARG FFUF_VERSION=v2.1.0

RUN set -eux; \
  arch="$(uname -m)"; \
  case "$arch" in \
    x86_64)  goarch="amd64" ;; \
    aarch64|arm64) goarch="arm64" ;; \
    *) echo "Unsupported arch for security tools: $arch" >&2; exit 1 ;; \
  esac; \
  # subfinder
  curl -fsSL -o /tmp/subfinder.zip "https://github.com/projectdiscovery/subfinder/releases/download/${SUBFINDER_VERSION}/subfinder_${SUBFINDER_VERSION#v}_linux_${goarch}.zip" \
  && python3 -c "import zipfile; zipfile.ZipFile('/tmp/subfinder.zip').extractall('/tmp/subfinder')" \
  && install -m 0755 /tmp/subfinder/subfinder /usr/local/bin/subfinder \
  && rm -rf /tmp/subfinder /tmp/subfinder.zip; \
  # httpx
  curl -fsSL -o /tmp/httpx.zip "https://github.com/projectdiscovery/httpx/releases/download/${HTTPX_VERSION}/httpx_${HTTPX_VERSION#v}_linux_${goarch}.zip" \
  && python3 -c "import zipfile; zipfile.ZipFile('/tmp/httpx.zip').extractall('/tmp/httpx')" \
  && install -m 0755 /tmp/httpx/httpx /usr/local/bin/httpx \
  && rm -rf /tmp/httpx /tmp/httpx.zip; \
  # nuclei
  curl -fsSL -o /tmp/nuclei.zip "https://github.com/projectdiscovery/nuclei/releases/download/${NUCLEI_VERSION}/nuclei_${NUCLEI_VERSION#v}_linux_${goarch}.zip" \
  && python3 -c "import zipfile; zipfile.ZipFile('/tmp/nuclei.zip').extractall('/tmp/nuclei')" \
  && install -m 0755 /tmp/nuclei/nuclei /usr/local/bin/nuclei \
  && rm -rf /tmp/nuclei /tmp/nuclei.zip; \
  # ffuf
  curl -fsSL -o /tmp/ffuf.tar.gz "https://github.com/ffuf/ffuf/releases/download/${FFUF_VERSION}/ffuf_${FFUF_VERSION#v}_linux_${goarch}.tar.gz" \
  && tar -xzf /tmp/ffuf.tar.gz -C /tmp ffuf \
  && install -m 0755 /tmp/ffuf /usr/local/bin/ffuf \
  && rm -f /tmp/ffuf /tmp/ffuf.tar.gz; \
  # verify
  subfinder -version && httpx -version && nuclei -version && ffuf -V

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
