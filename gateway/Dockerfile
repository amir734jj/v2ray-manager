FROM node:lts-bookworm-slim AS frontend-build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY gateway/package.json ./gateway/
COPY generator/package.json ./generator/
RUN npm ci --workspace frontend
COPY frontend/ ./frontend/
RUN npm run build

FROM node:lts-bookworm-slim AS gateway-dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json ./frontend/
COPY gateway/package.json ./gateway/
COPY generator/package.json ./generator/
RUN npm ci --workspace gateway --omit=dev
COPY gateway/ ./gateway/
COPY generator/package.json generator/connections.js ./generator/

FROM oven/bun:latest
RUN mkdir -p /data/metrics && chown bun:bun /data/metrics
WORKDIR /app
COPY --from=gateway-dependencies /app/node_modules ./node_modules
COPY --from=gateway-dependencies /app/gateway ./gateway
COPY --from=gateway-dependencies /app/generator ./generator
COPY --from=frontend-build /app/gateway/public ./gateway/public
USER bun
CMD ["bun", "gateway/server.js"]
