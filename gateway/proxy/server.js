import httpProxy from 'http-proxy-3';
import { parsePort } from '../services/config.js';
import { createGatewayHandler } from './gateway.js';
import { createTunnelHandler } from './tunnels.js';
import { activeTunnelIps, disconnectTunnelSockets } from './sockets.js';
import { logUpstreamTraffic } from './upstream-traffic.js';

export function createGatewayProxy({ upstreamHost, ports, blocklist, logger, trustCloudflareHeaders = false, logTraffic = true }) {
  const routes = new Map(Object.entries(ports).map(([protocol, port]) => [
    `/${protocol}`, `http://${upstreamHost}:${parsePort(port, `/${protocol} upstream port`)}`,
  ]));
  const sockets = new Map();
  const tunnelSockets = new Map();
  const wsConnections = new WeakMap();
  const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });
  let stopUpstreamTraffic;

  proxy.on('error', (error, request, response) => {
    const connection = wsConnections.get(request);
    if (connection?.blocked) return;
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
    disconnectTunnel: id => disconnectTunnelSockets(tunnelSockets, id),
    listTunnelIps: id => [...activeTunnelIps(tunnelSockets, id)].sort(),
    blocklist: {
      list: blocklist.list,
      async block(value) {
        const ip = await blocklist.block(value);
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
        const ip = await blocklist.unblock(value);
        logger.info({ ip }, 'Gateway IP unblocked');
        return ip;
      },
    },
    createHandler: app => createGatewayHandler({ app, routes }),
    attach(server, { tunnels }) {
      if (logTraffic) stopUpstreamTraffic = logUpstreamTraffic(proxy, logger);
      server.on('upgrade', createTunnelHandler({
        tunnels, routes, blocklist, logger, sockets, tunnelSockets, wsConnections, proxy, trustCloudflareHeaders,
      }));
      server.on('connection', socket => {
        sockets.set(socket, null);
        socket.once('close', () => sockets.delete(socket));
      });
    },
    stop() {
      stopUpstreamTraffic?.();
      for (const socket of sockets.keys()) socket.destroy();
    },
    close() {
      proxy.close();
    },
  };
}
