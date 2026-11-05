import express from 'express';
import { createFrontendController } from './controllers/index.js';
import { createSubscriptionsRouter } from './proxy/index.js';
import { createErrorHandler } from './services/index.js';

const statusHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function createGatewayApp({ logger, ...options }) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.use((request, response, next) => {
    response.set(statusHeaders);
    const host = request.headers.host;
    const websocketSources = typeof host === 'string' && /^(?:\[[a-f0-9:.]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/i.test(host)
      ? ` ws://${host} wss://${host}` : '';
    response.set('content-security-policy',
      `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'${websocketSources}; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    next();
  });
  app.use(createSubscriptionsRouter({ tunnels: options.tunnels }));
  app.use(createFrontendController(options));
  app.use(createErrorHandler(logger));
  return app;
}
