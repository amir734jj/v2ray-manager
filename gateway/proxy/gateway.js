import { parseTunnelPath } from './paths.js';
import { serveAccessNotice } from './notices.js';

export function createGatewayHandler({ app, routes, blocklist, tunnels, logger, trustProxy, trustCloudflareHeaders }) {
  return (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const subscriptionNotice = /^\/subscriptions\/([^/]+)\/status$/.exec(path);
    if (path === '/blocked' || subscriptionNotice) {
      return serveAccessNotice(request, response, {
        blocklist, tunnels, logger, trustProxy, trustCloudflareHeaders, subscriptionToken: subscriptionNotice?.[1],
      });
    }
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
