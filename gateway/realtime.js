import { Server } from 'socket.io';
import { authenticateSession, listAccounts } from './accounts.js';
import { getSessionToken, isSameOrigin } from './auth.js';
import { gatewayEvents } from './events.js';
import { statusSnapshot } from './status.js';

export function attachRealtime(server, { accounts, blocklist, secureCookies, logger, ipDetails }) {
  const io = new Server(server, {
    path: '/socket.io/',
    transports: ['websocket'],
    destroyUpgrade: false,
    serveClient: false,
    maxHttpBufferSize: 16384,
  });
  const clients = new Set();
  const notify = resource => {
    for (const client of clients) client.schedule(resource);
  };
  const onStatus = () => notify('status');
  const onUsers = () => notify('users');
  const onHeartbeat = () => notify('users');
  const onRevoked = token => {
    for (const client of clients) {
      if (client.token === token) client.expire();
    }
  };
  gatewayEvents.on('status', onStatus);
  gatewayEvents.on('users', onUsers);
  gatewayEvents.on('heartbeat', onHeartbeat);
  gatewayEvents.on('session-revoked', onRevoked);
  server.once('close', () => {
    gatewayEvents.off('status', onStatus);
    gatewayEvents.off('users', onUsers);
    gatewayEvents.off('heartbeat', onHeartbeat);
    gatewayEvents.off('session-revoked', onRevoked);
  });

  io.use(async (socket, next) => {
    if (!isSameOrigin(socket.request.headers)) {
      const error = new Error('A same-origin request is required');
      error.data = { code: 'FORBIDDEN' };
      next(error);
      return;
    }
    const token = getSessionToken(socket.request, secureCookies);
    try {
      const user = await authenticateSession(accounts, token);
      if (!user) {
        const error = new Error('Please log in with an active account');
        error.data = { code: 'UNAUTHORIZED' };
        next(error);
        return;
      }
      socket.data.token = token;
      next();
    } catch (error) {
      logger.error({ err: error }, 'Realtime authentication failed');
      const failure = new Error('Realtime authentication is unavailable');
      failure.data = { code: 'UNAVAILABLE' };
      next(failure);
    }
  });

  io.on('connection', socket => {
    const subscriptions = new Set();
    const pending = new Set();
    let timer;
    let sending = false;
    const client = {
      token: socket.data.token,
      expire() {
        socket.emit('session-expired');
        socket.disconnect(true);
      },
      schedule(resource) {
        if (!subscriptions.has(resource) || !socket.connected) return;
        pending.add(resource);
        if (!timer && !sending) {
          timer = setTimeout(flush, 100);
          timer.unref();
        }
      },
    };
    clients.add(client);

    async function flush() {
      timer = undefined;
      if (sending || !socket.connected) return;
      sending = true;
      const resources = [...pending];
      pending.clear();
      try {
        const user = await authenticateSession(accounts, client.token);
        if (!socket.connected) return;
        if (!user) {
          client.expire();
          return;
        }
        for (const resource of resources) {
          if (!subscriptions.has(resource)) continue;
          if (resource === 'users' && !user.admin) {
            subscriptions.delete(resource);
            socket.emit('resource-error', { resource, message: 'Administrator access is required' });
            continue;
          }
          const data = resource === 'status'
            ? statusSnapshot(blocklist, ipDetails)
            : { users: await listAccounts(accounts) };
          if (socket.connected && subscriptions.has(resource)) socket.emit('resource', { resource, data });
        }
      } catch (error) {
        logger.error({ err: error }, 'Realtime update failed');
        if (socket.connected) {
          for (const resource of resources) {
            if (subscriptions.has(resource)) {
              socket.emit('resource-error', { resource, message: 'Realtime update failed; retrying on the next change' });
            }
          }
        }
      } finally {
        sending = false;
        if (socket.connected && pending.size && !timer) {
          timer = setTimeout(flush, 100);
          timer.unref();
        }
      }
    }

    socket.on('subscribe', resource => {
      if (!['status', 'users'].includes(resource)) {
        socket.emit('resource-error', {
          resource: typeof resource === 'string' ? resource : '',
          message: 'Unknown realtime resource',
        });
        return;
      }
      subscriptions.add(resource);
      client.schedule(resource);
    });
    socket.on('unsubscribe', resource => {
      subscriptions.delete(resource);
      pending.delete(resource);
    });
    socket.on('disconnect', () => {
      clearTimeout(timer);
      clients.delete(client);
    });
  });
  return io;
}
