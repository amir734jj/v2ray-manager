import express from 'express';
import { statusSnapshot } from '../services/index.js';

export function createStatusController({ blocklist, ipDetails, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.get('/api/status.json', auth.requireUser, (_request, response) => {
    response.json(statusSnapshot(blocklist, ipDetails));
  });
  return router;
}
