import { createServer } from 'node:http';
import httpProxy from 'http-proxy';

const listenPort = Number.parseInt(process.env.GATEWAY_PORT ?? '53217', 10);
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  throw new Error('GATEWAY_PORT must be a valid TCP port');
}

const upstreamHost = process.env.V2RAY_UPSTREAM_HOST ?? 'v2ray';
const protocols = {
  '/vless': process.env.V2RAY_VLESS_PORT ?? '53217',
  '/vmess': process.env.V2RAY_VMESS_PORT ?? '53218',
  '/trojan': process.env.V2RAY_TROJAN_PORT ?? '53219',
  '/shadowsocks': process.env.V2RAY_SHADOWSOCKS_PORT ?? '53220',
};
const routes = new Map(
  Object.entries(protocols).map(([path, port]) => {
    const parsedPort = Number.parseInt(port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`${path} upstream port must be a valid TCP port`);
    }
    return [path, `http://${upstreamHost}:${parsedPort}`];
  }),
);

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
});

proxy.on('error', (error, _request, response) => {
  console.error('Gateway proxy error:', error.message);
  if ('writeHead' in response) {
    if (!response.headersSent) response.writeHead(502);
    response.end('Bad Gateway\n');
  } else {
    response.destroy();
  }
});

const server = createServer((request, response) => {
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
  proxy.ws(request, socket, head, { target });
});

server.on('error', error => {
  console.error('Gateway server error:', error.message);
  process.exitCode = 1;
});

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`WebSocket gateway listening on port ${listenPort}`);
});

function shutdown() {
  server.close(error => {
    proxy.close();
    if (error) {
      console.error('Gateway shutdown error:', error.message);
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
