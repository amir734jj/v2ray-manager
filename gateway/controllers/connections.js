import express from 'express';
import createError from 'http-errors';
import { connectionsSnapshot, sameOrigin } from '../services';

export function createConnectionsController({ tunnels, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.get('/api/connections', auth.requireUser, auth.requireAdmin, async (_request, response) => {
    if (!tunnels) throw createError(503, 'Tunnel management is unavailable');
    response.json(await connectionsSnapshot(tunnels));
  });
  router.post('/api/connections', auth.requireUser, auth.requireAdmin, sameOrigin, express.json({ limit: '2kb' }), async (request, response) => {
    if (!tunnels) throw createError(503, 'Tunnel management is unavailable');
    response.status(201).json(await tunnels.create(request.body?.name, request.body?.maxConcurrentIps));
  });
  router.post('/api/connections/:id/:action', auth.requireUser, auth.requireAdmin, sameOrigin, express.json({ limit: '2kb' }), async (request, response) => {
    if (!tunnels) throw createError(503, 'Tunnel management is unavailable');
    response.json(await tunnels.change(request.params.id, request.params.action, request.body));
  });
  return router;
}
