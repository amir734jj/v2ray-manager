import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { Passport } from 'passport';
import { Strategy as CustomStrategy } from 'passport-custom';
import { Strategy as LocalStrategy } from 'passport-local';
import {
  authenticateSession, createSession, registerAccount, revokeSession, SESSION_SECONDS, verifyAccount,
} from './accounts.js';
import { gatewayEvents } from './events.js';

export function isSameOrigin(headers) {
  let origin;
  try {
    origin = new URL(headers.origin);
  } catch {
    return false;
  }
  return ['http:', 'https:'].includes(origin.protocol) && origin.host === headers.host;
}

export function sameOrigin(request, _response, next) {
  if (!isSameOrigin(request.headers)) {
    next(Object.assign(new Error('A same-origin request is required'), { status: 403 }));
    return;
  }
  next();
}

export function getSessionToken(request, secureCookies) {
  const cookieName = secureCookies ? '__Host-gateway_session' : 'gateway_session';
  const cookie = request.headers.cookie?.split(';').map(value => value.trim())
    .find(value => value.startsWith(`${cookieName}=`));
  return cookie?.slice(cookieName.length + 1);
}

export function createAuth({ accounts, secureCookies = true }) {
  if (!accounts) throw new Error('Account storage is required');
  const router = express.Router();
  const cookieName = secureCookies ? '__Host-gateway_session' : 'gateway_session';
  const cookieOptions = { httpOnly: true, secure: secureCookies, sameSite: 'strict', path: '/' };
  const passport = new Passport();
  const token = request => getSessionToken(request, secureCookies);
  passport.use('local', new LocalStrategy((username, password, done) => {
    verifyAccount(accounts, { username, password }).then(user => done(null, user), done);
  }));
  passport.use('gateway-session', new CustomStrategy((request, done) => {
    authenticateSession(accounts, token(request)).then(user => done(null, user || false), done);
  }));
  const authLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_request, _response, next) => next(Object.assign(
      new Error('Too many authentication attempts; retry in 15 minutes'), { status: 429 },
    )),
  });
  function requireUser(request, response, next) {
    passport.authenticate('gateway-session', { session: false }, (error, user) => {
      if (error) return next(error);
      if (!user) return response.status(401).json({ error: 'Please log in with an active account' });
      request.user = user;
      next();
    })(request, response, next);
  }
  function requireAdmin(request, response, next) {
    if (!request.user.admin) {
      response.status(403).json({ error: 'Administrator access is required' });
      return;
    }
    next();
  }
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
    passport.authenticate('local', { session: false }, async (error, user) => {
      if (error) return next(error);
      if (!user) return next(Object.assign(new Error('Invalid username or password'), { status: 401 }));
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
  router.get('/me', requireUser, (request, response) => response.json({ user: request.user }));
  return { router, initialize: passport.initialize(), requireUser, requireAdmin };
}
