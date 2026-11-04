import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bootstrapCss = readFileSync(require.resolve('bootstrap/dist/css/bootstrap.min.css'), 'utf8');
const views = fileURLToPath(new URL('.', import.meta.url));
const statusHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'referrer-policy': 'no-referrer',
};
const startedAt = new Date();
const counters = ['vless', 'vmess', 'trojan', 'shadowsocks'].map(protocol => ({
  transport: 'ws', protocol, active: 0, total: 0, errors: 0,
}));
const countries = new Map();
const clients = new Set();
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const MAX_CLIENT_DETAILS = 1000;
export const MAX_USER_AGENT_LENGTH = 256;

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
  connection.once('close', () => {
    counter.active--;
    countryCounter.active--;
    if (client) clients.delete(client);
  });
  let failed = false;
  return () => {
    if (!failed) {
      counter.errors++;
      countryCounter.errors++;
    }
    failed = true;
  };
}

function snapshot() {
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

export function createStatusApp() {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.set('view engine', 'pug');
  app.set('views', views);
  app.enable('view cache');
  app.all(['/', '/status', '/status.json'], (request, response) => {
    response.set(statusHeaders);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.set('Allow', 'GET, HEAD').status(405).type('text').send('Method Not Allowed\n');
      return;
    }
    if (request.path === '/status.json') {
      response.json(snapshot());
      return;
    }
    response.render('status', {
      ...snapshot(),
      bootstrapCss,
      statusPath: request.path,
      expandedIp: typeof request.query.client === 'string' ? request.query.client : undefined,
    });
  });
  return app;
}
