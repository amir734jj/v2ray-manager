import express from 'express';
import { createAuth } from '../services/index.js';
import { createAuthController } from './auth.js';
import { createUsersController } from './users.js';
import { createConnectionsController } from './connections.js';
import { createBlocklistController } from './blocklist.js';
import { createStatusController } from './status.js';
import { createResourceHistoryController } from './resource-history.js';
import { createPagesController } from './pages.js';

export function createFrontendController({ blocklist, accounts, tunnels, resourceHistory, ipDetails, secureCookies = true } = {}) {
  const router = express.Router({ strict: true, caseSensitive: true });
  const auth = createAuth({ accounts, secureCookies });
  router.use(auth.initialize);
  router.use('/api/auth', createAuthController({ accounts, auth, secureCookies }));
  router.use(createUsersController({ accounts, tunnels, auth }));
  router.use(createConnectionsController({ tunnels, auth }));
  router.use(createBlocklistController({ blocklist, auth }));
  router.use(createStatusController({ blocklist, ipDetails, auth }));
  router.use(createResourceHistoryController({ resourceHistory, auth }));
  router.use(createPagesController());
  return router;
}
