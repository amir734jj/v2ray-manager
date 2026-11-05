export function disconnectTunnelSockets(sockets, id) {
  for (const [socket, connection] of sockets) {
    if (connection?.client.tunnelId === id) {
      connection.blocked = true;
      socket.destroy();
    }
  }
}
export function activeTunnelIps(sockets, id) {
  const ips = new Set();
  for (const [socket, connection] of sockets) {
    if (!socket.destroyed && !connection?.blocked && connection?.client.tunnelId === id && connection.client.ip) {
      ips.add(connection.client.ip);
    }
  }
  return ips;
}
