import { isPublicIp } from '../services/blocklist.js';
import lodash from 'lodash';

export function isIpLimitReached(ips, ip, maxConcurrentIps) {
  if (maxConcurrentIps <= 0 || !isPublicIp(ip)) return false;
  const publicIps = new Set(lodash.filter([...ips], isPublicIp));
  return !publicIps.has(ip) && publicIps.size >= maxConcurrentIps;
}

export function trackTunnelSocket(tunnelSockets, socket, connection) {
  const id = connection.client.tunnelId;
  let group = tunnelSockets.get(id);
  if (!group) {
    group = new Map();
    tunnelSockets.set(id, group);
  }
  group.set(socket, connection);
  socket.once('close', () => {
    group.delete(socket);
    if (group.size === 0) tunnelSockets.delete(id);
  });
}

export function disconnectTunnelSockets(tunnelSockets, id, reason = 'subscription_disabled') {
  const group = tunnelSockets.get(id);
  if (!group) return;
  for (const [socket, connection] of group) {
    connection.blocked = true;
    connection.diagnostics?.gatewayClose(reason);
    socket.destroy();
  }
}
export function activeTunnelIps(tunnelSockets, id) {
  const ips = new Set();
  const group = tunnelSockets.get(id);
  if (!group) return ips;
  for (const [socket, connection] of group) {
    if (!socket.destroyed && !connection.blocked && connection.client.ip && isPublicIp(connection.client.ip)) {
      ips.add(connection.client.ip);
    }
  }
  return ips;
}
