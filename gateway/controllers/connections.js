import express from 'express';
import createError from 'http-errors';
import { sameOrigin } from '../services/index.js';

export function createConnectionsController({ tunnels, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.post('/api/users/:id/connection', auth.requireUser, auth.requireAdmin, sameOrigin, async (request, response) => {
    if (!tunnels) throw createError(503, 'Tunnel management is unavailable');
    response.status(201).json(await tunnels.create(request.params.id));
  });
  router.post('/api/connections/:id/:action', auth.requireUser, auth.requireAdmin, sameOrigin, async (request, response) => {
    if (!tunnels) throw createError(503, 'Tunnel management is unavailable');
    response.json(await tunnels.change(request.params.id, request.params.action));
  });
  return router;
}
