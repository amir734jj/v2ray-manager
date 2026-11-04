import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { hashPassword } from '../gateway/accounts.mjs';
import { createStatusApp } from '../gateway/status.mjs';

test('management HTTP routes are under /api and retain authentication and origin checks', async t => {
  const password = 'password1234';
  const admin = {
    id: '00000000-0000-0000-0000-000000000001',
    username: 'admin',
    passwordHash: await hashPassword(password),
    active: true,
    admin: true,
    createdAt: new Date().toISOString(),
  };
  const viewer = { ...admin, id: '00000000-0000-0000-0000-000000000002', username: 'viewer', admin: false };
  const users = [admin, viewer];
  const sessions = new Map();
  const accounts = {
    User: {
      findOne: async ({ where }) => users.find(user => user.username === where.username),
      findByPk: async id => users.find(user => user.id === id),
      findAll: async () => users.map(({ passwordHash, ...user }) => user),
    },
    Session: {
      create: async session => sessions.set(session.tokenHash, session),
      findOne: async ({ where }) => sessions.get(where.tokenHash),
      destroy: async ({ where }) => {
        if (where.tokenHash) sessions.delete(where.tokenHash);
      },
    },
    dummyHash: admin.passwordHash,
  };
  const blocked = new Set();
  const blocklist = {
    list: () => [...blocked],
    block: async ip => blocked.add(ip),
    unblock: async ip => blocked.delete(ip),
  };
  const app = createStatusApp({ accounts, blocklist, secureCookies: false });
  app.use((error, _request, response, _next) => {
    response.status(error.status ?? 500).json({ error: error.message });
  });
  const server = createServer(app);
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, options);
  const post = (body, cookie, requestOrigin = origin) => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(requestOrigin && { origin: requestOrigin }),
      ...(cookie && { cookie }),
    },
    body: JSON.stringify(body),
  });

  assert.equal((await request('/api/auth/me')).status, 401);
  assert.equal((await request('/api/status.json')).status, 401);
  assert.equal((await request('/api/users')).status, 401);
  assert.equal((await request('/api/blocklist/block')).status, 405);
  assert.equal((await request('/api/auth/login', post({ username: 'admin', password }, null, ''))).status, 403);
  assert.equal((await request('/api/auth/register', post({}, null, ''))).status, 403);

  const login = await request('/api/auth/login', post({ username: 'admin', password }));
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.username, 'admin');
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const authenticated = { headers: { cookie } };
  assert.equal((await request('/api/auth/me', authenticated)).status, 200);
  assert.equal((await request('/api/status.json', authenticated)).status, 200);
  assert.equal((await request('/api/users', authenticated)).status, 200);
  assert.equal((await request('/api/blocklist/block', post({ ip: '192.0.2.1' }, cookie, ''))).status, 403);
  const blockedResponse = await request('/api/blocklist/block', post({ ip: '192.0.2.1' }, cookie));
  assert.deepEqual((await blockedResponse.json()).blockedIPs, ['192.0.2.1']);
  const unblockedResponse = await request('/api/blocklist/unblock', post({ ip: '192.0.2.1' }, cookie));
  assert.deepEqual((await unblockedResponse.json()).blockedIPs, []);

  const viewerLogin = await request('/api/auth/login', post({ username: 'viewer', password }));
  const viewerCookie = viewerLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/users', { headers: { cookie: viewerCookie } })).status, 403);
  assert.equal((await request('/api/blocklist/block', post({ ip: '192.0.2.1' }, viewerCookie))).status, 403);
  assert.equal((await request('/api/auth/logout', post({}, cookie))).status, 204);
  assert.equal((await request('/api/auth/me', authenticated)).status, 401);

  for (const path of ['/auth/me', '/status.json', '/blocklist/block', '/blocklist/unblock']) {
    assert.equal((await request(path, authenticated)).status, 404, path);
  }
});
