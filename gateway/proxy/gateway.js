import { parseTunnelPath } from './paths.js';

export function createGatewayHandler({ app, routes }) {
  return (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/healthz') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok\n');
      return;
    }
    if (parseTunnelPath(path)) {
      response.writeHead(426, { 'content-type': 'text/plain' });
      response.end('WebSocket upgrade required\n');
      return;
    }
    if (routes.has(path)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Shared tunnel paths are disabled\n');
      return;
    }
    app(request, response);
  };
}
