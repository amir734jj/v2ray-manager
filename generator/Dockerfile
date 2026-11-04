FROM node:22-alpine
RUN apk add --no-cache git curl
WORKDIR /app
COPY package.json package-lock.json /app/
COPY frontend/package.json /app/frontend/
COPY gateway/package.json /app/gateway/
COPY generator/package.json /app/generator/
RUN npm ci --workspace generator --omit=dev
COPY generator/init.js generator/connections.js /app/generator/
COPY v2ray/templates/ /app/templates/
CMD ["node", "/app/generator/init.js"]
