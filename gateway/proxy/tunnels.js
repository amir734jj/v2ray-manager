import { randomUUID } from 'node:crypto';
import { MAX_USER_AGENT_LENGTH, trackConnection } from '../services/status.js';
import { clientAddress } from '../services/client-ip.js';
import { parseTunnelPath } from './paths.js';
import { activeTunnelIps, isIpLimitReached, trackTunnelSocket } from './sockets.js';
import { parsePort } from '../services/config.js';
import { createTunnelDiagnostics } from './diagnostics.js';

export function createTunnelHandler({
  tunnels, routes, blocklist, logger, sockets, tunnelSockets, wsConnections, proxy, trustCloudflareHeaders = 'auto', trustProxy,
  diagnostics = createTunnelDiagnostics({ logger }),
}) {
  function clientMetadata(request) {
    const { headers } = request;
    return {
      ...clientAddress(request, { trustProxy, trustCloudflareHeaders, logger }),
      userAgent: headers['user-agent']?.trim().slice(0, MAX_USER_AGENT_LENGTH) || 'Unknown',
    };
  }

  function upgradeTunnel(request, socket, head, attempt) {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path.startsWith('/socket.io/')) return;
    const parsed = parseTunnelPath(path);
    if (!parsed) {
      diagnostics.rejected(attempt, 404, 'unknown_tunnel_path');
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (diagnostics.enabled) {
      Object.assign(attempt, { ...clientMetadata(request), connectionId: randomUUID(), protocol: parsed.protocol });
    }
    const tunnel = tunnels.authorize(path);
    if (socket.destroyed) return;
    if (!tunnel) {
      diagnostics.rejected(attempt, 403, 'credential_unavailable');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    Object.assign(attempt, { tunnelId: tunnel.id, subscriptionName: tunnel.name });
    let target = routes.get(`/${tunnel.protocol}`);
    if (tunnel.upstreamPort !== undefined) {
      const endpoint = new URL(target);
      endpoint.port = String(parsePort(tunnel.upstreamPort, 'Tunnel upstream port'));
      target = endpoint.href;
    }
    const metadata = diagnostics.enabled ? attempt : clientMetadata(request);
    Object.assign(attempt, { ...metadata, connectionId: attempt.connectionId ?? randomUUID(), protocol: tunnel.protocol });
    if (metadata.ip && blocklist.has(metadata.ip)) {
      logger.warn({ ...metadata, protocol: tunnel.protocol }, 'Gateway connection blocked');
      diagnostics.rejected(attempt, 403, 'ip_blocked');
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 8\r\n\r\nBlocked\n');
      return;
    }
    if (tunnel.maxConcurrentIps > 0) {
      if (!metadata.ip) {
        logger.warn({ tunnelId: tunnel.id, protocol: tunnel.protocol }, 'Gateway limited connection rejected: client IP unavailable');
        diagnostics.rejected(attempt, 403, 'client_ip_unavailable');
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      const ips = activeTunnelIps(tunnelSockets, tunnel.id);
      if (isIpLimitReached(ips, metadata.ip, tunnel.maxConcurrentIps)) {
        logger.warn({
          tunnelId: tunnel.id, protocol: tunnel.protocol, ip: metadata.ip,
          activeIpCount: ips.size, maxConcurrentIps: tunnel.maxConcurrentIps,
        }, 'Gateway concurrent IP limit reached');
        diagnostics.rejected(attempt, 429, 'ip_limit', { activeIpCount: ips.size, maxConcurrentIps: tunnel.maxConcurrentIps });
        socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        return;
      }
    }
    const client = {
      ...attempt,
      transport: 'ws',
      protocol: tunnel.protocol,
      tunnelId: tunnel.id,
      subscriptionName: tunnel.name,
      connectedAt: new Date().toISOString(),
    };
    const connection = {
      client,
      fail: trackConnection('ws', client.protocol, socket, { ...client, bufferedBytes: head.length }),
      blocked: false,
    };
    connection.diagnostics = diagnostics.track(socket, client, head.length);
    sockets.set(socket, connection);
    trackTunnelSocket(tunnelSockets, socket, connection);
    wsConnections.set(request, connection);
    request.url = `/${tunnel.protocol}`;
    proxy.ws(request, socket, head, { target });
  }

  return (request, socket, head) => {
    const attempt = {};
    try {
      upgradeTunnel(request, socket, head, attempt);
    } catch (error) {
      logger.error({ err: error }, 'Tunnel authorization failed');
      diagnostics.rejected(attempt, 503, 'authorization_or_proxy_failure', { errorCode: error.code ?? null });
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  };
}
