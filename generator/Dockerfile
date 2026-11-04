FROM node:22-alpine
RUN apk add --no-cache git curl
WORKDIR /app
COPY package.json package-lock.json /app/
RUN npm ci --omit=dev
COPY generator/init.mjs generator/connections.mjs /app/
COPY v2ray/templates/ /app/templates/
CMD ["node", "/app/init.mjs"]
