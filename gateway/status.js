import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createTrafficMeter } from './traffic.js';
import { createResourceMeter } from './resources.js';
import { createAuth, sameOrigin } from './auth.js';
import { activateAccount, listAccounts } from './accounts.js';
import { gatewayEvents } from './events.js';

const publicDirectory = fileURLToPath(new URL('./public', import.meta.url));
const statusHeaders = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const startedAt = new Date();
const traffic = createTrafficMeter();
const resources = createResourceMeter();
let resourceRecording = null;
let pendingResourceWrite = null;
let resourceRecordingError = null;

export function startResourceRecording(history, logger) {
  resourceRecording = { history, logger };
}

export async function stopResourceRecording() {
  resourceRecording = null;
  await pendingResourceWrite;
}

function recordResources() {
  if (!resourceRecording) return;
  const { history, logger } = resourceRecording;
  if (pendingResourceWrite) {
    resourceRecordingError = 'A resource history sample was skipped; check gateway logs';
    logger.warn('Resource history sample skipped: previous write is still running');
    return;
  }
  const { cpuPercent, memory } = resources.snapshot();
  const { uploadBytesPerSecond, downloadBytesPerSecond } = traffic.rates();
  if (cpuPercent === null) return;
  const totals = connectionTotals();
  const sample = {
    timestamp: Date.now(),
    cpuPercent,
    rssBytes: memory.rssBytes,
    heapUsedBytes: memory.heapUsedBytes,
    heapTotalBytes: memory.heapTotalBytes,
    openClientSockets: totals.active,
    connectionAttempts: totals.total,
    proxyFailures: totals.errors,
    ...(uploadBytesPerSecond === null ? {} : { uploadBytesPerSecond }),
    ...(downloadBytesPerSecond === null ? {} : { downloadBytesPerSecond }),
  };
  pendingResourceWrite = history.record(sample).then(() => {
    resourceRecordingError = null;
  }).catch(error => {
    resourceRecordingError = 'Resource history recording failed; check gateway logs';
    logger.error({ err: error }, 'Resource history recording failed');
  }).finally(() => {
    pendingResourceWrite = null;
  });
}

setInterval(() => {
  traffic.sample();
  resources.sample();
  recordResources();
  gatewayEvents.emit('status');
  gatewayEvents.emit('heartbeat');
}, 5000).unref();
const counters = ['vless', 'vmess', 'trojan'].map(protocol => ({
  transport: 'ws', protocol, active: 0, total: 0, errors: 0,
}));
const countries = new Map();
const clients = new Map();
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const MAX_CLIENT_DETAILS = 1000;
export const MAX_USER_AGENT_LENGTH = 256;

function connectionTotals() {
  const totals = { active: 0, total: 0, errors: 0 };
  for (const row of counters) {
    totals.active += row.active;
    totals.total += row.total;
    totals.errors += row.errors;
  }
  return totals;
}

export function trackConnection(transport, protocol, connection, {
  country, ip, userAgent, connectionId = randomUUID(), connectedAt = new Date().toISOString(), bufferedBytes = 0,
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
  const clientTraffic = traffic.track(connection, bufferedBytes, Boolean(client));
  if (client) clients.set(client, clientTraffic);
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

export function snapshot(ipDetails) {
  const totals = connectionTotals();
  const activeClients = [...clients].map(([client, clientTraffic]) => ({
    ...client,
    traffic: clientTraffic.snapshot(),
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(client.connectedAt)) / 1000)),
  }));
  const groups = new Map();
  for (const client of activeClients) {
    if (!groups.has(client.ip)) {
      groups.set(client.ip, {
        ip: client.ip, active: 0, countries: new Map(), protocols: new Set(),
        traffic: { uploadBytesPerSecond: null, downloadBytesPerSecond: null, sampledSockets: 0 },
      });
    }
    const group = groups.get(client.ip);
    group.active++;
    group.countries.set(client.countryCode, { code: client.countryCode, name: client.countryName });
    group.protocols.add(client.protocol);
    if (client.traffic.intervalSeconds !== null) group.traffic.sampledSockets++;
    for (const field of ['uploadBytesPerSecond', 'downloadBytesPerSecond']) {
      if (client.traffic[field] !== null) {
        group.traffic[field] = (group.traffic[field] ?? 0) + client.traffic[field];
      }
    }
  }
  return {
    startedAt: startedAt.toISOString(),
    uptimeSeconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
    totals,
    traffic: traffic.snapshot(),
    resources: resources.snapshot(),
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
      traffic: group.traffic,
      ipDetails: ipDetails ? ipDetails.lookup(group.ip) : { status: 'unavailable' },
    })).sort((a, b) => a.ip.localeCompare(b.ip)),
  };
}

export function statusSnapshot(blocklist, ipDetails) {
  return { ...snapshot(ipDetails), blockedIPs: blocklist ? blocklist.list() : [], blocklistAvailable: Boolean(blocklist) };
}

export function createStatusApp({ blocklist, accounts, resourceHistory, ipDetails, secureCookies = true } = {}) {
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
  app.use('/api/auth', router);
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
  app.all(['/api/blocklist/block', '/api/blocklist/unblock'], (request, response, next) => {
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
      if (request.path === '/api/blocklist/block') await blocklist.block(request.body?.ip);
      else await blocklist.unblock(request.body?.ip);
      gatewayEvents.emit('status');
      response.json({ blockedIPs: blocklist.list() });
    } catch (error) {
      if (error instanceof TypeError) error.status = 400;
      if (error instanceof RangeError) error.status = 409;
      next(error);
    }
  });
  app.get('/api/status.json', requireUser, (_request, response) => {
    response.json(statusSnapshot(blocklist, ipDetails));
  });
  app.get('/api/resource-history', requireUser, async (request, response) => {
    if (!resourceHistory) {
      throw Object.assign(new Error('Resource history is unavailable'), { status: 503 });
    }
    const history = await resourceHistory.read(request.query.range ?? '1h');
    response.json({ ...history, recordingError: resourceRecordingError });
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
