import { createHash, randomBytes, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import * as argon2 from 'argon2';
import createError from 'http-errors';
import { publicUser } from '../database/users.js';

const scrypt = promisify(deriveKey);
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const legacyKeyOptions = { N: 32768, maxmem: 64 * 1024 * 1024 };
const legacyHashPattern = /^[a-f0-9]{32}:[a-f0-9]{128}$/;
const argonOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const digest = token => createHash('sha256').update(token).digest('hex');

export function credentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = body?.password;
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
    throw createError(400, 'Username must be 3-64 characters: letters, numbers, dots, underscores or hyphens');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw createError(400, 'Password must be 10-128 characters');
  }
  return { username, password };
}

export async function hashPassword(password) {
  return argon2.hash(password, argonOptions);
}

export async function verifyPassword(password, hash) {
  if (!legacyHashPattern.test(hash)) return argon2.verify(hash, password);
  const [salt, encoded] = hash.split(':');
  const key = await scrypt(password, salt, 64, legacyKeyOptions);
  const expected = Buffer.from(encoded, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export async function initializeAccounts({ users, sessions }) {
  return {
    users,
    sessions,
    dummyHash: await hashPassword(randomBytes(32).toString('hex')),
  };
}

export async function registerAccount({ users }, body) {
  const { username, password } = credentials(body);
  const passwordHash = await hashPassword(password);
  return publicUser(await users.register({ username, passwordHash }));
}

export async function verifyAccount({ users, dummyHash }, body) {
  const { username, password } = credentials(body);
  const user = await users.findByUsername(username);
  const valid = await verifyPassword(password, user?.passwordHash ?? dummyHash);
  if (!user || !valid) throw createError(401, 'Invalid username or password');
  if (!user.active) throw createError(403, 'Your account is awaiting administrator activation');
  if (legacyHashPattern.test(user.passwordHash)) {
    const updated = await users.upgradePassword(user.id, user.passwordHash, await hashPassword(password));
    if (updated !== 1) throw createError(409, 'Account changed during login; please try again');
  }
  return publicUser(user);
}

export async function createSession({ sessions }, user) {
  const token = randomBytes(32).toString('hex');
  await sessions.create(digest(token), user.id, SESSION_SECONDS);
  return token;
}

export async function authenticateSession({ users, sessions }, token) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) return null;
  const session = await sessions.findActive(digest(token));
  if (!session) return null;
  const user = await users.findById(session.userId);
  return user?.active ? publicUser(user) : null;
}

export async function revokeSession({ sessions }, token) {
  if (/^[a-f0-9]{64}$/.test(token ?? '')) await sessions.revoke(digest(token));
}

export function listAccounts({ users }) {
  return users.list();
}

export async function activateAccount({ users }, id) {
  if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
    throw createError(400, 'Invalid user ID');
  }
  const user = await users.activate(id);
  if (!user) throw createError(404, 'User not found');
  return publicUser(user);
}
