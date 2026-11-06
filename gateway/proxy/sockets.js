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

export function disconnectTunnelSockets(tunnelSockets, id) {
  const group = tunnelSockets.get(id);
  if (!group) return;
  for (const [socket, connection] of group) {
    connection.blocked = true;
    socket.destroy();
  }
}
export function activeTunnelIps(tunnelSockets, id) {
  const ips = new Set();
  const group = tunnelSockets.get(id);
  if (!group) return ips;
  for (const [socket, connection] of group) {
    if (!socket.destroyed && !connection.blocked && connection.client.ip) {
      ips.add(connection.client.ip);
    }
  }
  return ips;
}
