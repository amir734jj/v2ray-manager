import express from 'express';
import createError from 'http-errors';
import { gatewayEvents, sameOrigin } from '../services/index.js';

export function createBlocklistController({ blocklist, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.all(['/api/blocklist/block', '/api/blocklist/unblock'], (request, response, next) => {
    if (request.method !== 'POST') {
      response.set('Allow', 'POST').status(405).type('text').send('Method Not Allowed\n');
      return;
    }
    if (!blocklist) {
      next(createError(404, 'Blocklist controls are unavailable'));
      return;
    }
    next();
  }, auth.requireUser, auth.requireAdmin, sameOrigin, express.json({ limit: '1kb' }), async (request, response, next) => {
    try {
      if (request.path === '/api/blocklist/block') await blocklist.block(request.body?.ip);
      else await blocklist.unblock(request.body?.ip);
      gatewayEvents.emit('status');
      response.json({ blockedIPs: blocklist.list() });
    } catch (error) {
      if (error instanceof TypeError) error.status = 400;
      if (error instanceof RangeError) error.status = 409;
      next(error);
    }
  });
  return router;
}
