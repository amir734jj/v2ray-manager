import { createServer } from 'node:http';
import { isIP } from 'node:net';
import httpProxy from 'http-proxy-3';
import pino from 'pino';
import pretty from 'pino-pretty';
import { trackConnection, createStatusApp } from './status.mjs';

const logger = pino({
  base: undefined,
}, pretty({
  colorize: false,
  translateTime: 'UTC:HH:MM:ss',
  ignore: 'pid,hostname,transport,port,err',
  singleLine: true,
  sync: true,
}));

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

function logConnection(transport, protocol, headers, remoteAddress) {
  let ip = remoteAddress ?? null;
  let country = null;
  if (trustCloudflareHeaders === 'true') {
    const clientIp = headers['cf-connecting-ip'];
    const clientCountry = headers['cf-ipcountry'];
    if (typeof clientIp === 'string' && isIP(clientIp)) {
      ip = clientIp;
      if (typeof clientCountry === 'string' && /^(?:[A-Z]{2}|T1)$/.test(clientCountry)) {
        country = clientCountry;
      } else if (clientCountry !== undefined) {
        logger.warn('Gateway connection metadata: invalid CF-IPCountry ignored');
      }
    } else if (clientIp !== undefined) {
      logger.warn('Gateway connection metadata: invalid CF-Connecting-IP ignored');
    }
  }
  logger.info(`${transport.toUpperCase()} ${protocol} | IP=${ip ?? 'unknown'} | country=${country ?? 'unknown'}`);
  return country;
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

const wsFailures = new WeakMap();
proxy.on('error', (error, request, response) => {
  wsFailures.get(request)?.();
  logger.error({ err: error }, `Gateway proxy error: ${error.message}`);
  if ('writeHead' in response) {
    if (!response.headersSent) response.writeHead(502);
    response.end('Bad Gateway\n');
  } else {
    response.destroy();
  }
});

const statusApp = createStatusApp();
statusApp.use((error, _request, response, next) => {
  logger.error({ err: error }, `Gateway status page error: ${error.message}`);
  if (response.headersSent) {
    next(error);
    return;
  }
  response.status(500).type('text').send('Internal Server Error\n');
});
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/' || path === '/status' || path === '/status.json') {
    statusApp(request, response);
    return;
  }
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
  response.writeHead(404, { 'content-type': 'text/plain' });
  response.end('Not Found\n');
});

server.on('upgrade', (request, socket, head) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const target = routes.get(path);
  if (!target) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const country = logConnection('ws', path.slice(1), request.headers, socket.remoteAddress);
  wsFailures.set(request, trackConnection('ws', path.slice(1), socket, country));
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

const sockets = new Set();
server.on('connection', socket => {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const socket of sockets) socket.destroy();
  server.close(error => {
    proxy.close();
    if (error) {
      logger.error({ err: error }, `Gateway shutdown error: ${error.message}`);
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
