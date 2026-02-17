FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache tmux

# Install dependencies (includes tsx used by reference-node script).
COPY package.json package-lock.json ./
RUN npm ci

# Copy reference-node implementation.
COPY examples/nexus-node ./examples/nexus-node
# Reference node MCP bridge imports src/mcp/stdio-client.ts at runtime.
COPY src/mcp/stdio-client.ts ./src/mcp/stdio-client.ts

ENV NEXUS_NODE_STATE_DIR=/data/nexus-node
VOLUME ["/data/nexus-node"]

# Gateway URL is configured via NEXUS_NODE_GATEWAY_URL (or reference-node default).
CMD ["npm", "run", "node:reference"]
