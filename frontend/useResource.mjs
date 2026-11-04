import { useCallback, useContext, useEffect, useState } from 'preact/hooks';
import { RealtimeContext } from './realtime.mjs';

const resources = { '/api/status.json': 'status', '/api/users': 'users' };

export function useResource(path) {
  const socket = useContext(RealtimeContext);
  const resource = resources[path];
  if (!resource) throw new Error(`Unknown realtime resource: ${path}`);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    if (socket?.connected) socket.emit('subscribe', resource);
  }, [socket, resource]);

  useEffect(() => {
    if (!socket) return;
    function connect() {
      setError('');
      socket.emit('subscribe', resource);
    }
    function receive(message) {
      if (message.resource !== resource) return;
      setData(message.data);
      setError('');
      setLoading(false);
    }
    function resourceError(message) {
      if (message.resource !== resource) return;
      setError(`${message.message}; displayed data may be stale.`);
      setLoading(false);
    }
    function connectionError(failure) {
      setError(`Realtime connection failed; displayed data may be stale. ${failure.message}`);
      setLoading(false);
    }
    function disconnect() {
      setError('Realtime connection lost; displayed data may be stale. Reconnecting...');
      setLoading(false);
    }
    socket.on('connect', connect);
    socket.on('resource', receive);
    socket.on('resource-error', resourceError);
    socket.on('connect_error', connectionError);
    socket.on('disconnect', disconnect);
    if (socket.connected) connect();
    return () => {
      socket.off('connect', connect);
      socket.off('resource', receive);
      socket.off('resource-error', resourceError);
      socket.off('connect_error', connectionError);
      socket.off('disconnect', disconnect);
      if (socket.connected) socket.emit('unsubscribe', resource);
    };
  }, [socket, resource]);

  return { data, error, loading, refresh };
}
