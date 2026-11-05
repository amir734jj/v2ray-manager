import { createServer } from 'node:http';
import httpProxy from 'http-proxy-3';
import { createGatewayLogger } from '../services/logger.js';
import { logUpstreamTraffic } from './upstream-traffic.js';

const [protocol, target] = process.argv.slice(2);
if (!process.send || !['vless', 'vmess', 'trojan'].includes(protocol) || !target) {
  throw new Error('Proxy workers must be started by the gateway with a protocol and upstream target');
}
const logger = createGatewayLogger().child({ protocol });
const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: false });
const sockets = new Set();
const server = createServer((request, response) => {
  response.writeHead(404);
  response.end();
});
const stopTraffic = logUpstreamTraffic(proxy, logger);
let stopping = false;

proxy.on('error', (error, request, socket) => {
  logger.error({ err: error }, 'Route worker upstream proxy error');
  socket.destroy();
});
function trackSocket(socket) {
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
}
server.on('connection', trackSocket);
proxy.on('proxyReqWs', request => request.once('socket', trackSocket));
server.on('upgrade', (request, socket, head) => {
  if (request.url !== `/${protocol}`) {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  proxy.ws(request, socket, head, { target });
});
server.on('error', error => {
  logger.error({ err: error }, 'Proxy route worker server error');
  process.exitCode = 1;
  shutdown();
});

function shutdown() {
  if (stopping) return;
  stopping = true;
  stopTraffic();
  for (const socket of sockets) socket.destroy();
  server.close(() => {
    proxy.close();
    if (process.connected) process.disconnect();
  });
}

process.on('message', message => {
  if (message?.type === 'stop') shutdown();
});
process.on('disconnect', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(0, '127.0.0.1', () => {
  process.send({ type: 'ready', port: server.address().port });
});
