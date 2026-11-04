import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import httpProxy from 'http-proxy-3';
import pino from 'pino';
import pretty from 'pino-pretty';
import { trackConnection, trackProxyTraffic, createStatusApp, MAX_USER_AGENT_LENGTH } from './status.mjs';
import { normalizeIp } from './blocklist.mjs';
import { createDatabase } from './database.mjs';

const logger = pino({
  base: undefined,
  redact: {
    paths: [
      'headers.authorization',
      'headers["proxy-authorization"]',
      'headers.cookie',
      'headers["set-cookie"]',
      'headers["x-api-key"]',
      'headers["cf-access-jwt-assertion"]',
    ],
    censor: '[REDACTED]',
  },
}, pretty({
  colorize: false,
  translateTime: 'UTC:HH:MM:ss',
  ignore: 'pid,hostname',
  sync: true,
}));

function logRequest(request) {
  logger.info({
    method: request.method,
    path: new URL(request.url, 'http://localhost').pathname,
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
  }, 'Gateway request');
}

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

const listenPort = parsePort(process.env.GATEWAY_PORT ?? '53217', 'GATEWAY_PORT');
const upstreamHost = process.env.V2RAY_UPSTREAM_HOST ?? 'v2ray';
const trustCloudflareHeaders = process.env.GATEWAY_TRUST_CLOUDFLARE_HEADERS ?? 'false';
if (!['true', 'false'].includes(trustCloudflareHeaders)) {
  throw new Error('GATEWAY_TRUST_CLOUDFLARE_HEADERS must be true or false');
}
const secureCookies = process.env.GATEWAY_SECURE_COOKIES ?? 'true';
if (!['true', 'false'].includes(secureCookies)) {
  throw new Error('GATEWAY_SECURE_COOKIES must be true or false');
}
const { blocklist: storedBlocklist, accounts, close: closeDatabase } = await createDatabase(process.env.DATABASE_URL);
const sockets = new Map();

function clientMetadata(request) {
  const { headers } = request;
  const { remoteAddress } = request.socket;
  let ip = remoteAddress ? normalizeIp(remoteAddress) : null;
  let country = null;
  if (trustCloudflareHeaders === 'true') {
    const clientIp = headers['cf-connecting-ip'];
    const clientCountry = headers['cf-ipcountry'];
    if (typeof clientIp === 'string' && !clientIp.includes('%') && isIP(clientIp)) {
      ip = normalizeIp(clientIp);
      if (typeof clientCountry === 'string' && /^(?:[A-Z]{2}|T1)$/.test(clientCountry)) {
        country = clientCountry;
      } else if (clientCountry !== undefined) {
        logger.warn('Gateway connection metadata: invalid CF-IPCountry ignored');
      }
    } else if (clientIp !== undefined) {
      logger.warn('Gateway connection metadata: invalid CF-Connecting-IP ignored');
    }
  }
  return {
    ip,
    country: country && country !== 'XX' ? country : 'unknown',
    userAgent: headers['user-agent']?.trim().slice(0, MAX_USER_AGENT_LENGTH) || 'Unknown',
  };
}

function logConnection(transport, protocol, request, metadata) {
  const openedAt = performance.now();
  const client = {
    ...metadata,
    connectionId: randomUUID(),
    transport,
    protocol,
    connectedAt: new Date().toISOString(),
  };
  logger.info({
    ...client,
    method: request.method,
    path: new URL(request.url, 'http://localhost').pathname,
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
  }, 'Gateway connection opened');
  request.socket.once('close', () => {
    logger.info({
      ...client,
      durationMs: Math.round(performance.now() - openedAt),
    }, 'Gateway connection closed');
  });
  return client;
}

const protocols = {
  '/vless': process.env.V2RAY_VLESS_PORT ?? '53217',
  '/vmess': process.env.V2RAY_VMESS_PORT ?? '53218',
  '/trojan': process.env.V2RAY_TROJAN_PORT ?? '53219',
  '/shadowsocks': process.env.V2RAY_SHADOWSOCKS_PORT ?? '53220',
};
function createRoutes(entries) {
  return new Map(
    Object.entries(entries).map(([path, port]) => [
      path, `http://${upstreamHost}:${parsePort(port, `${path} upstream port`)}`,
    ]),
  );
}

const routes = createRoutes(protocols);

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
});

const wsConnections = new WeakMap();
proxy.on('error', (error, request, response) => {
  const connection = wsConnections.get(request);
  if (connection?.blocked) {
    logger.info({ ...connection.client, err: error }, 'Gateway proxy ended after IP block');
    return;
  }
  connection?.fail();
  logger.error({ ...connection?.client, err: error }, `Gateway proxy error: ${error.message}`);
  if ('writeHead' in response) {
    if (!response.headersSent) response.writeHead(502);
    response.end('Bad Gateway\n');
  } else {
    response.destroy();
  }
});

const statusApp = createStatusApp({
  accounts,
  secureCookies: secureCookies === 'true',
  blocklist: {
    list: storedBlocklist.list,
    async block(value) {
      const ip = await storedBlocklist.block(value);
      let disconnected = 0;
      for (const [socket, connection] of sockets) {
        if (connection?.client.ip === ip && !socket.destroyed) {
          connection.blocked = true;
          socket.destroy();
          disconnected++;
        }
      }
      logger.warn({ ip, disconnected }, 'Gateway IP blocked');
      return ip;
    },
    async unblock(value) {
      const ip = await storedBlocklist.unblock(value);
      logger.info({ ip }, 'Gateway IP unblocked');
      return ip;
    },
  },
});
statusApp.use((error, _request, response, next) => {
  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500 ? error.status : 500;
  const message = error.type === 'entity.parse.failed' ? 'Invalid JSON request' : error.message;
  if (status < 500) logger.warn({ status }, `Gateway status page error: ${message}`);
  else logger.error({ err: error }, 'Gateway status page error');
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(status).json({ error: status < 500 ? message : 'Internal Server Error' });
});
const server = createServer((request, response) => {
  logRequest(request);
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/healthz') {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ok\n');
    return;
  }
  if (routes.has(path)) {
    response.writeHead(426, { 'content-type': 'text/plain' });
    response.end('WebSocket upgrade required\n');
    return;
  }
  statusApp(request, response);
});

server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const target = routes.get(path);
  if (!target) {
    logRequest(request);
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const metadata = clientMetadata(request);
  if (metadata.ip && storedBlocklist.has(metadata.ip)) {
    logger.warn({ ...metadata, protocol: path.slice(1), headers: request.headers }, 'Gateway connection blocked');
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 8\r\n\r\nBlocked\n');
    return;
  }
  const client = logConnection('ws', path.slice(1), request, metadata);
  const connection = { client, fail: trackConnection('ws', path.slice(1), socket, client), blocked: false };
  trackProxyTraffic(socket, head.length);
  sockets.set(socket, connection);
  wsConnections.set(request, connection);
  proxy.ws(request, socket, head, { target });
});

function serverError(error) {
  logger.error({ err: error }, `Gateway server error: ${error.message}`);
  process.exitCode = 1;
  shutdown();
}
server.on('error', serverError);

server.listen(listenPort, '0.0.0.0', () => {
  logger.info({ transport: 'ws', port: listenPort }, `WebSocket gateway listening on port ${listenPort}`);
});

server.on('connection', socket => {
  sockets.set(socket, null);
  socket.once('close', () => sockets.delete(socket));
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets.keys()) socket.destroy();
  server.close(async error => {
    proxy.close();
    if (error) {
      logger.error({ err: error }, `Gateway shutdown error: ${error.message}`);
      process.exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (databaseError) {
      logger.error({ err: databaseError }, 'Gateway PostgreSQL shutdown error');
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
