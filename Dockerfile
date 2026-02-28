FROM node:22-bookworm-slim

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

# Configure git for container environment (safe.directory for mounted volumes,
# identity for automated commits by coder agents)
RUN git config --global --add safe.directory '*' \
  && git config --global user.email "nexus@local" \
  && git config --global user.name "Nexus"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Python runtime: LangExtract + PDF/image utilities for creative skills
RUN python3 -m venv /opt/nexus-py \
  && /opt/nexus-py/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/nexus-py/bin/pip install --no-cache-dir \
    'langextract[openai]' pypdf \
    img2pdf Pillow cairosvg

# Make the CLI available on PATH inside the container (so `docker exec ... nexus ...` works)
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/nexus \
  && chmod +x /usr/local/bin/nexus

ENV PATH="/opt/nexus-py/bin:$PATH"
ENV NEXUS_STATE_DIR=/data/nexus
ENV NEXUS_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NEXUS_BROWSER_HEADLESS=1
ENV NEXUS_BROWSER_NO_SANDBOX=1
ENV NEXUS_LANGEXTRACT_PYTHON=/opt/nexus-py/bin/python

EXPOSE 18789

ENTRYPOINT ["nexus"]
CMD ["chat"]
