FROM node:22-alpine AS dependencies
RUN apk add --no-cache git
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY gateway/server.mjs gateway/healthcheck.mjs ./
USER node
CMD ["node", "server.mjs"]
