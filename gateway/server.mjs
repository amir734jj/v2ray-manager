import { createServer } from 'node:http';
import { createServer as createHttp2Server, connect, constants } from 'node:http2';
import httpProxy from 'http-proxy';

function parsePort(value, name) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

const listenPort = parsePort(process.env.GATEWAY_PORT ?? '53217', 'GATEWAY_PORT');
const grpcListenPort = parsePort(process.env.GATEWAY_GRPC_PORT ?? '53317', 'GATEWAY_GRPC_PORT');
const upstreamHost = process.env.V2RAY_UPSTREAM_HOST ?? 'v2ray';
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
const grpcRoutes = createRoutes({
  '/vless-grpc': process.env.V2RAY_VLESS_GRPC_PORT ?? '53317',
  '/vmess-grpc': process.env.V2RAY_VMESS_GRPC_PORT ?? '53318',
  '/trojan-grpc': process.env.V2RAY_TROJAN_GRPC_PORT ?? '53319',
  '/shadowsocks-grpc': process.env.V2RAY_SHADOWSOCKS_GRPC_PORT ?? '53320',
});

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

const grpcServer = createHttp2Server();
const grpcSessions = new Set();
grpcServer.on('session', session => {
  grpcSessions.add(session);
  session.on('error', error => console.error('Gateway gRPC session error:', error.message));
  session.once('close', () => grpcSessions.delete(session));
});

grpcServer.on('stream', (stream, headers) => {
  stream.on('error', error => console.error('Gateway gRPC stream error:', error.message));
  const path = headers[':path'] ?? '';
  if (path === '/healthz') {
    stream.respond({ ':status': 200, 'content-type': 'text/plain' });
    stream.end('ok\n');
    return;
  }
  const service = path.split('/')[1];
  const target = grpcRoutes.get(`/${service}`);
  if (!target || !path.startsWith(`/${service}/`)) {
    stream.respond({ ':status': 404, 'content-type': 'text/plain' });
    stream.end('Not Found\n');
    return;
  }

  const session = connect(target);
  let upstream;
  let failed = false;
  const fail = error => {
    if (failed || stream.destroyed) return;
    failed = true;
    console.error('Gateway gRPC proxy error:', error.message);
    if (stream.headersSent) {
      stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    } else {
      stream.respond({ ':status': 502, 'content-type': 'text/plain' });
      stream.end('Bad Gateway\n');
    }
    upstream?.destroy();
    session.destroy();
  };
  session.on('error', fail);
  stream.once('close', () => {
    upstream?.close(constants.NGHTTP2_CANCEL);
    session.destroy();
  });

  let requestTrailers = {};
  let responseTrailers = {};
  stream.on('trailers', trailers => { requestTrailers = trailers; });
  upstream = session.request({
    ...headers,
    ':scheme': 'http',
    ':authority': new URL(target).host,
  }, { waitForTrailers: true });
  upstream.on('error', fail);
  upstream.once('wantTrailers', () => {
    if (!upstream.destroyed) upstream.sendTrailers(requestTrailers);
  });
  upstream.once('response', responseHeaders => {
    if (!stream.destroyed) stream.respond(responseHeaders, { waitForTrailers: true });
  });
  upstream.on('trailers', trailers => { responseTrailers = trailers; });
  stream.once('wantTrailers', () => {
    if (!stream.destroyed) stream.sendTrailers(responseTrailers);
  });
  upstream.once('close', () => {
    if (!upstream.readableEnded) fail(new Error('Upstream gRPC stream closed before completion'));
    session.close();
  });
  stream.pipe(upstream);
  upstream.pipe(stream);
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

function serverError(error) {
  console.error('Gateway server error:', error.message);
  process.exitCode = 1;
  shutdown();
}
server.on('error', serverError);
grpcServer.on('error', serverError);

server.listen(listenPort, '0.0.0.0', () => {
  console.log(`WebSocket gateway listening on port ${listenPort}`);
});
grpcServer.listen(grpcListenPort, '0.0.0.0', () => {
  console.log(`gRPC gateway listening on port ${grpcListenPort}`);
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
  for (const session of grpcSessions) session.destroy();
  server.close(error => {
    proxy.close();
    if (error) {
      console.error('Gateway shutdown error:', error.message);
      process.exitCode = 1;
    }
  });
  grpcServer.close(error => {
    if (error) {
      console.error('Gateway gRPC shutdown error:', error.message);
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
