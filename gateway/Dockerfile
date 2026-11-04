FROM node:lts-bookworm-slim AS dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends git ca-certificates
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend/ ./frontend/
RUN npm run build && npm prune --omit=dev

FROM oven/bun:latest
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY gateway/ ./
COPY --from=dependencies /app/gateway/public ./public
USER bun
CMD ["bun", "server.mjs"]
