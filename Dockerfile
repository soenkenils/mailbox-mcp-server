FROM oven/bun:1-alpine AS builder

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./
RUN bun run tsc

FROM oven/bun:1-alpine AS production-dependencies

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

LABEL org.opencontainers.image.title="mailbox-mcp-server" \
  org.opencontainers.image.description="Mailbox.org MCP server" \
  org.opencontainers.image.source="https://github.com/soenkenils/mailbox-mcp-server"

COPY --from=production-dependencies /app/package.json ./package.json
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
RUN npm install --global supergateway@3.4.3

USER node

ENTRYPOINT ["node", "dist/main.js"]
