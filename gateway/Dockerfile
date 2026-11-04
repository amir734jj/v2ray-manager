FROM node:22-alpine AS dependencies
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY frontend/ ./frontend/
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY gateway/ ./
COPY --from=dependencies /app/gateway/public ./public
USER node
CMD ["node", "server.mjs"]
