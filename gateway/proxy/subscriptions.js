import express from 'express';
import createError from 'http-errors';

export function createSubscriptionsRouter({ tunnels }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.get('/subscriptions/:token', async (request, response) => {
    if (!tunnels) throw createError(503, 'Tunnel management is unavailable');
    const client = /^v2rayNG\//i.test(request.get('User-Agent') ?? '') ? 'v2rayng' : '';
    response.vary('User-Agent');
    response.type('text/plain').send(await tunnels.subscription(request.params.token, client));
  });
  return router;
}
