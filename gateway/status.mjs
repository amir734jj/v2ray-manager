import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTrafficMeter } from './traffic.mjs';
import { createAuth, sameOrigin } from './auth.mjs';
import { activateAccount, listAccounts } from './accounts.mjs';
import { gatewayEvents } from './events.mjs';

const publicDirectory = fileURLToPath(new URL('./public', import.meta.url));
const statusHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const startedAt = new Date();
const traffic = createTrafficMeter();
setInterval(() => {
  traffic.sample();
  gatewayEvents.emit('status');
  gatewayEvents.emit('heartbeat');
}, 5000).unref();
const counters = ['vless', 'vmess', 'trojan', 'shadowsocks'].map(protocol => ({
  transport: 'ws', protocol, active: 0, total: 0, errors: 0,
}));
const countries = new Map();
const clients = new Set();
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const MAX_CLIENT_DETAILS = 1000;
export const MAX_USER_AGENT_LENGTH = 256;
export const trackProxyTraffic = traffic.track;

export function trackConnection(transport, protocol, connection, {
  country, ip, userAgent, connectionId = randomUUID(), connectedAt = new Date().toISOString(),
} = {}) {
  const counter = counters.find(item => item.transport === transport && item.protocol === protocol);
  const code = typeof country === 'string' && /^(?:[A-Z]{2}|T1)$/.test(country) && country !== 'XX'
    ? country : 'unknown';
  if (!countries.has(code)) {
    countries.set(code, {
      code,
      name: code === 'unknown' ? 'Unknown' : code === 'T1' ? 'Tor' : countryNames.of(code),
      active: 0, total: 0, errors: 0,
    });
  }
  const countryCounter = countries.get(code);
  const client = clients.size < MAX_CLIENT_DETAILS ? {
    connectionId,
    ip: ip ?? 'unknown',
    protocol,
    transport,
    countryCode: code,
    countryName: countryCounter.name,
    userAgent: typeof userAgent === 'string' && userAgent.trim()
      ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : 'Unknown',
    connectedAt,
  } : null;
  if (client) clients.add(client);
  for (const row of [counter, countryCounter]) {
    row.active++;
    row.total++;
  }
  gatewayEvents.emit('status');
  connection.once('close', () => {
    counter.active--;
    countryCounter.active--;
    if (client) clients.delete(client);
    gatewayEvents.emit('status');
  });
  let failed = false;
  return () => {
    if (!failed) {
      counter.errors++;
      countryCounter.errors++;
      gatewayEvents.emit('status');
    }
    failed = true;
  };
}

export function snapshot() {
  const totals = counters.reduce((total, row) => ({
    active: total.active + row.active,
    total: total.total + row.total,
    errors: total.errors + row.errors,
  }), { active: 0, total: 0, errors: 0 });
  const activeClients = [...clients].map(client => ({
    ...client,
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(client.connectedAt)) / 1000)),
  }));
  const groups = new Map();
  for (const client of activeClients) {
    if (!groups.has(client.ip)) {
      groups.set(client.ip, { ip: client.ip, active: 0, countries: new Map(), protocols: new Set() });
    }
    const group = groups.get(client.ip);
    group.active++;
    group.countries.set(client.countryCode, { code: client.countryCode, name: client.countryName });
    group.protocols.add(client.protocol);
  }
  return {
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    totals,
    traffic: traffic.snapshot(),
    connections: counters,
    countries: [...countries.values()].sort((a, b) => b.total - a.total || a.code.localeCompare(b.code)),
    clients: activeClients,
    clientDetails: {
      limit: MAX_CLIENT_DETAILS,
      shown: activeClients.length,
      omitted: totals.active - activeClients.length,
    },
    clientGroups: [...groups.values()].map(group => ({
      ip: group.ip,
      active: group.active,
      countries: [...group.countries.values()].sort((a, b) => a.code.localeCompare(b.code)),
      protocols: [...group.protocols].sort(),
    })).sort((a, b) => a.ip.localeCompare(b.ip)),
  };
}

export function statusSnapshot(blocklist) {
  return { ...snapshot(), blockedIPs: blocklist ? blocklist.list() : [], blocklistAvailable: Boolean(blocklist) };
}

export function createStatusApp({ blocklist, accounts, secureCookies = true } = {}) {
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
  const { router, initialize, requireUser, requireAdmin } = createAuth({ accounts, secureCookies });
  app.use(initialize);
  app.use('/auth', router);
  app.use('/assets', express.static(fileURLToPath(new URL('./public/assets', import.meta.url)), {
    index: false, redirect: false,
  }));
  app.get('/api/users', requireUser, requireAdmin, async (_request, response) => {
    response.json({ users: await listAccounts(accounts) });
  });
  app.post('/api/users/:id/activate', requireUser, requireAdmin, sameOrigin, async (request, response) => {
    const user = await activateAccount(accounts, request.params.id);
    gatewayEvents.emit('users');
    response.json({ user });
  });
  app.all(['/blocklist/block', '/blocklist/unblock'], (request, response, next) => {
    if (request.method !== 'POST') {
      response.set('Allow', 'POST').status(405).type('text').send('Method Not Allowed\n');
      return;
    }
    if (!blocklist) {
      next(Object.assign(new Error('Blocklist controls are unavailable'), { status: 404 }));
      return;
    }
    next();
  }, requireUser, requireAdmin, sameOrigin, express.json({ limit: '1kb' }), async (request, response, next) => {
    try {
      if (request.path === '/blocklist/block') await blocklist.block(request.body?.ip);
      else await blocklist.unblock(request.body?.ip);
      gatewayEvents.emit('status');
      response.json({ blockedIPs: blocklist.list() });
    } catch (error) {
      if (error instanceof TypeError) error.status = 400;
      if (error instanceof RangeError) error.status = 409;
      next(error);
    }
  });
  app.get('/status.json', requireUser, (_request, response) => {
    response.json(statusSnapshot(blocklist));
  });
  app.all(['/', '/status', '/login', '/register', '/blocked-ips', '/users'], (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.set('Allow', 'GET, HEAD').status(405).type('text').send('Method Not Allowed\n');
      return;
    }
    response.sendFile('index.html', { root: publicDirectory });
  });
  return app;
}
