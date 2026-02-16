FROM node:22-alpine

WORKDIR /app

# Install dependencies (includes tsx used by reference-node script).
COPY package.json package-lock.json ./
RUN npm ci

# Copy reference-node implementation.
COPY examples/nexus-node ./examples/nexus-node

ENV NEXUS_NODE_STATE_DIR=/data/nexus-node
VOLUME ["/data/nexus-node"]

# Gateway URL is configured via NEXUS_NODE_GATEWAY_URL (or reference-node default).
CMD ["npm", "run", "node:reference"]
