# Base images are pinned by digest so a rebuild cannot silently pull a
# different image. Refresh deliberately with:
#   docker pull oven/bun:1 && docker image inspect oven/bun:1 --format '{{index .RepoDigests 0}}'
FROM oven/bun:1@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build

WORKDIR /app

# Dependencies are installed from the committed lockfile only; --frozen-lockfile
# fails the build if package.json and bun.lock disagree.
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src
RUN bun run build

# Re-resolve without dev dependencies so only runtime code ships.
RUN rm -rf node_modules && bun install --frozen-lockfile --production

FROM node:22-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46

# A container is only useful in http mode; stdio stays the default for a
# locally launched process. MCP_AUTH_TOKEN and the MAILBOX_* credentials are
# supplied at runtime by the host, never baked into the image.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    PORT=8080
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 8080

# Absolute path: the entry guard in main.ts compares import.meta.url against
# process.argv[1]. Serve it behind a TLS-terminating proxy.
CMD ["node", "/app/dist/main.js"]
