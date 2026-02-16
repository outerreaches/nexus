FROM node:22-alpine

WORKDIR /app

# Install dependencies (includes tsx used by reference-node script).
COPY package.json package-lock.json ./
RUN npm ci

# Copy reference-node implementation.
COPY examples/nexus-node ./examples/nexus-node

ENV NEXUS_NODE_STATE_DIR=/data/nexus-node
VOLUME ["/data/nexus-node"]

# Default points to a gateway service name on a Docker network.
CMD ["npm", "run", "node:reference", "--", "--gateway", "ws://gateway:18789/nx/nodes"]
