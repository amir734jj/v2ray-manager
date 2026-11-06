import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { MAX_USER_AGENT_LENGTH, trackConnection } from '../services/status.js';
import { normalizeIp } from '../services/blocklist.js';
import { parseTunnelPath } from './paths.js';
import { activeTunnelIps, trackTunnelSocket } from './sockets.js';

export function createTunnelHandler({
  tunnels, routes, blocklist, logger, sockets, tunnelSockets, wsConnections, proxy, trustCloudflareHeaders = false,
}) {
  function clientMetadata(request) {
    const { headers } = request;
    const { remoteAddress } = request.socket;
    let ip = remoteAddress ? normalizeIp(remoteAddress) : null;
    let country = null;
    if (trustCloudflareHeaders) {
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

  async function upgradeTunnel(request, socket, head) {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/socket.io/')) return;
    const parsed = parseTunnelPath(path);
    if (!parsed) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const tunnel = await tunnels.authorize(path);
    if (socket.destroyed) return;
    if (!tunnel) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const target = routes.get(`/${tunnel.protocol}`);
    const metadata = clientMetadata(request);
    if (metadata.ip && blocklist.has(metadata.ip)) {
      logger.warn({ ...metadata, protocol: tunnel.protocol }, 'Gateway connection blocked');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 8\r\n\r\nBlocked\n');
      return;
    }
    if (tunnel.maxConcurrentIps > 0) {
      if (!metadata.ip) {
        logger.warn({ tunnelId: tunnel.id, protocol: tunnel.protocol }, 'Gateway limited connection rejected: client IP unavailable');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const ips = activeTunnelIps(tunnelSockets, tunnel.id);
      if (!ips.has(metadata.ip) && ips.size >= tunnel.maxConcurrentIps) {
        logger.warn({
          tunnelId: tunnel.id, protocol: tunnel.protocol, maxConcurrentIps: tunnel.maxConcurrentIps,
        }, 'Gateway concurrent IP limit reached');
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
    }
    const client = {
      ...metadata,
      connectionId: randomUUID(),
      transport: 'ws',
      protocol: tunnel.protocol,
      tunnelId: tunnel.id,
      connectedAt: new Date().toISOString(),
    };
    const connection = {
      client,
      fail: trackConnection('ws', client.protocol, socket, { ...client, bufferedBytes: head.length }),
      blocked: false,
    };
    sockets.set(socket, connection);
    trackTunnelSocket(tunnelSockets, socket, connection);
    wsConnections.set(request, connection);
    request.url = `/${tunnel.protocol}`;
    proxy.ws(request, socket, head, { target });
  }

  return (request, socket, head) => {
    upgradeTunnel(request, socket, head).catch(error => {
      logger.error({ err: error }, 'Tunnel authorization failed');
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  };
}
