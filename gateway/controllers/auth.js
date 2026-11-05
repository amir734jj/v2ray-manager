import express from 'express';
import { rateLimit } from 'express-rate-limit';
import createError from 'http-errors';
import {
  createSession, getSessionToken, registerAccount, revokeSession, sameOrigin,
  SESSION_SECONDS, gatewayEvents,
} from '../services/index.js';

export function createAuthController({ accounts, auth, secureCookies = true }) {
  const router = express.Router();
  const cookieName = secureCookies ? '__Host-gateway_session' : 'gateway_session';
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' };
  const token = request => getSessionToken(request, secureCookies);
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_request, _response, next) => next(createError(429, 'Too many authentication attempts; retry in 15 minutes')),
  });
  router.use((request, response, next) => {
    if (request.method !== 'POST') return next();
    sameOrigin(request, response, next);
  });
  router.use(express.json({ limit: '2kb' }));
  router.post('/register', authLimit, async (request, response) => {
    const user = await registerAccount(accounts, request.body);
    gatewayEvents.emit('users');
    response.status(201).json({ user });
  });
  router.post('/login', authLimit, (request, response, next) => {
    auth.passport.authenticate('local', { session: false }, async (error, user) => {
      if (error) return next(error);
      if (!user) return next(createError(401, 'Invalid username or password'));
      try {
        const newToken = await createSession(accounts, user);
        const oldToken = token(request);
        await revokeSession(accounts, oldToken);
        if (oldToken) gatewayEvents.emit('session-revoked', oldToken);
        response.cookie(cookieName, newToken, { ...cookieOptions, maxAge: SESSION_SECONDS * 1000 });
        response.json({ user });
      } catch (sessionError) {
        next(sessionError);
      }
    })(request, response, next);
  });
  router.post('/logout', async (request, response) => {
    const oldToken = token(request);
    await revokeSession(accounts, oldToken);
    if (oldToken) gatewayEvents.emit('session-revoked', oldToken);
    response.clearCookie(cookieName, cookieOptions).sendStatus(204);
  });
  router.get('/me', auth.requireUser, (request, response) => response.json({ user: request.user }));
  return router;
}
