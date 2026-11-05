import { parseCookie } from 'cookie';
import createError from 'http-errors';
import { Passport } from 'passport';
import { Strategy as CustomStrategy } from 'passport-custom';
import { Strategy as LocalStrategy } from 'passport-local';
import {
  authenticateSession, verifyAccount,
} from './accounts.js';

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
    next(createError(403, 'A same-origin request is required'));
    return;
  }
  next();
}

export function getSessionToken(request, secureCookies) {
  const cookieName = secureCookies ? '__Host-gateway_session' : 'gateway_session';
  return parseCookie(request.headers.cookie ?? '', { decode: value => value })[cookieName];
}

export function createAuth({ accounts, secureCookies = true }) {
  if (!accounts) throw new Error('Account storage is required');
  const passport = new Passport();
  const token = request => getSessionToken(request, secureCookies);
  passport.use('local', new LocalStrategy((username, password, done) => {
    verifyAccount(accounts, { username, password }).then(user => done(null, user), done);
  }));
  passport.use('gateway-session', new CustomStrategy((request, done) => {
    authenticateSession(accounts, token(request)).then(user => done(null, user || false), done);
  }));
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
  return { passport, initialize: passport.initialize(), requireUser, requireAdmin };
}
