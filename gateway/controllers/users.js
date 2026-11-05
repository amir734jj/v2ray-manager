import express from 'express';
import { activateAccount, gatewayEvents, sameOrigin, usersSnapshot } from '../services/index.js';

export function createUsersController({ accounts, tunnels, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.get('/api/users', auth.requireUser, auth.requireAdmin, async (_request, response) => {
    response.json(await usersSnapshot(accounts, tunnels));
  });
  router.post('/api/users/:id/activate', auth.requireUser, auth.requireAdmin, sameOrigin, async (request, response) => {
    const user = await activateAccount(accounts, request.params.id);
    gatewayEvents.emit('users');
    response.json({ user });
  });
  return router;
}
