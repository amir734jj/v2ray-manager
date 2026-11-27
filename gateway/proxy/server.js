import httpProxy from 'http-proxy-3';
import lodash from 'lodash';
import { parsePort } from '../services/config.js';
import { createGatewayHandler } from './gateway.js';
import { createTunnelHandler } from './tunnels.js';
import { activeTunnelIps, disconnectTunnelSockets } from './sockets.js';
import { logUpstreamTraffic } from './upstream-traffic.js';
import { createTunnelDiagnostics } from './diagnostics.js';

export function createGatewayProxy({ upstreamHost, ports, blocklist, logger, trustCloudflareHeaders = 'auto', trustProxy, logTraffic = true, tunnelDiagnostics = false, onDiagnosticsChange }) {
  const routes = new Map(lodash.map(lodash.toPairs(ports), ([protocol, port]) => [
    `/${protocol}`, `http://${upstreamHost}:${parsePort(port, `/${protocol} upstream port`)}`,
  ]));
  const sockets = new Map();
  const tunnelSockets = new Map();
  const wsConnections = new WeakMap();
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });
  const diagnostics = createTunnelDiagnostics({ enabled: tunnelDiagnostics, logger, onChange: onDiagnosticsChange });
  let stopUpstreamTraffic;
  let stopEventLoopDiagnostics;

  proxy.on('proxyReqWs', (request, incomingRequest) => {
    wsConnections.get(incomingRequest)?.diagnostics?.request(request);
  });

  proxy.on('error', (error, request, response) => {
    const connection = wsConnections.get(request);
    if (connection?.blocked) return;
    connection?.diagnostics?.proxyError(error);
    connection?.fail();
    logger.error({ ...connection?.client, err: error }, 'Gateway proxy error');
    if ('writeHead' in response) {
      if (!response.headersSent) response.writeHead(502);
      response.end('Bad Gateway\n');
    } else {
      response.destroy();
    }
  });

  return {
    diagnosticsSnapshot: diagnostics.snapshot,
    disconnectTunnel: (id, reason) => disconnectTunnelSockets(tunnelSockets, id, reason),
    listTunnelIps: id => lodash.sortBy([...activeTunnelIps(tunnelSockets, id)]),
    blocklist: {
      list: blocklist.list,
      async block(value) {
        const ip = await blocklist.block(value);
        let disconnected = 0;
        for (const [socket, connection] of sockets) {
          if (connection?.client.ip === ip && !socket.destroyed) {
            connection.blocked = true;
            connection.diagnostics?.gatewayClose('ip_blocked');
            socket.destroy();
            disconnected++;
          }
        }
        logger.warn({ ip, disconnected }, 'Gateway IP blocked');
        return ip;
      },
      async unblock(value) {
        const ip = await blocklist.unblock(value);
        logger.info({ ip }, 'Gateway IP unblocked');
        return ip;
      },
    },
    createHandler: (app, { tunnels } = {}) => createGatewayHandler({
      app, routes, blocklist, tunnels, logger, trustProxy, trustCloudflareHeaders,
    }),
    attach(server, { tunnels }) {
      stopEventLoopDiagnostics = diagnostics.watchEventLoop();
      if (logTraffic) stopUpstreamTraffic = logUpstreamTraffic(proxy, logger, routes.keys(), { tunnelSockets, wsConnections });
      server.on('upgrade', createTunnelHandler({
        tunnels, routes, blocklist, logger, sockets, tunnelSockets, wsConnections, proxy, trustCloudflareHeaders, trustProxy, diagnostics,
      }));
      server.on('connection', socket => {
        sockets.set(socket, null);
        socket.once('close', () => sockets.delete(socket));
      });
    },
    stop() {
      stopUpstreamTraffic?.();
      stopEventLoopDiagnostics?.();
      for (const [socket, connection] of sockets) {
        connection?.diagnostics?.gatewayClose('gateway_shutdown');
        socket.destroy();
      }
    },
    close() {
      proxy.close();
    },
  };
}
