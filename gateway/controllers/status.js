import express from 'express';
import { statusSnapshot } from '../services';

export function createStatusController({ blocklist, ipDetails, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.get('/api/status.json', auth.requireUser, (request, response) => {
    response.json(statusSnapshot(blocklist, ipDetails, request.user.admin));
  });
  return router;
}
