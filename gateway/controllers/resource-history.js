import express from 'express';
import createError from 'http-errors';
import { getResourceRecordingError } from '../services';

export function createResourceHistoryController({ resourceHistory, auth }) {
  const router = express.Router({ strict: true, caseSensitive: true });
  router.get('/api/resource-history', auth.requireUser, async (request, response) => {
    if (!resourceHistory) throw createError(503, 'Resource history is unavailable');
    const history = await resourceHistory.read(request.query.range ?? '1h');
    response.json({ ...history, recordingError: getResourceRecordingError() });
  });
  return router;
}
