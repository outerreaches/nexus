FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
RUN npm run build

# Make the CLI available on PATH inside the container (so `docker exec ... nexus ...` works)
RUN printf '%s\n' '#!/bin/sh' 'exec node /app/dist/index.js "$@"' > /usr/local/bin/nexus \
  && chmod +x /usr/local/bin/nexus

ENV NEXUS_STATE_DIR=/data/nexus
ENV NEXUS_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NEXUS_BROWSER_HEADLESS=1
ENV NEXUS_BROWSER_NO_SANDBOX=1

EXPOSE 18789

ENTRYPOINT ["nexus"]
CMD ["chat"]
