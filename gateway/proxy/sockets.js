export function disconnectTunnelSockets(sockets, id) {
  for (const [socket, connection] of sockets) {
    if (connection?.client.tunnelId === id) {
      connection.blocked = true;
      socket.destroy();
    }
  }
}
