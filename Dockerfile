FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY tsconfig.json ./

RUN npm ci --ignore-scripts
COPY index.ts ./
COPY src/ ./src/

RUN npm run build

FROM node:22-alpine
LABEL io.modelcontextprotocol.server.name="io.github.SamuelMoraesF/mcp-nfse-nacional"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist
RUN mkdir -p storage

ENV MCP_TRANSPORT=streamable-http
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3000
ENV NODE_OPTIONS="--openssl-legacy-provider"

EXPOSE 3000

CMD ["node", "--openssl-legacy-provider", "dist/index.js"]
