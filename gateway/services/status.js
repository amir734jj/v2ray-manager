import { randomUUID } from 'node:crypto';
import { createTrafficMeter } from './traffic.js';
import { createResourceMeter } from './resources.js';
import { listAccounts } from './accounts.js';
import { gatewayEvents } from './events.js';

const startedAt = new Date();
const traffic = createTrafficMeter();
const resources = createResourceMeter();
let resourceRecording = null;
let pendingResourceWrite = null;
let resourceRecordingError = null;

export function getResourceRecordingError() {
  return resourceRecordingError;
}

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
  country, ip, userAgent, userId, connectionId = randomUUID(), connectedAt = new Date().toISOString(), bufferedBytes = 0,
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
  const clientTraffic = traffic.track(connection, bufferedBytes, Boolean(client), { groupId: userId, connectedAt });
  if (client) clients.set(client, clientTraffic);
  for (const row of [counter, countryCounter]) {
    row.active++;
    row.total++;
  }
  gatewayEvents.emit('status');
  if (userId) gatewayEvents.emit('users');
  connection.once('close', () => {
    counter.active--;
    countryCounter.active--;
    if (client) clients.delete(client);
    gatewayEvents.emit('status');
    if (userId) gatewayEvents.emit('users');
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

export async function usersSnapshot(accounts, tunnels) {
  const users = await listAccounts(accounts);
  const state = tunnels ? await tunnels.list() : { connections: [], error: 'Tunnel management is unavailable' };
  const connections = new Map(state.connections.map(connection => [connection.userId, connection]));
  return {
    users: users.map(user => {
      const connection = connections.get(user.id);
      return { ...user, connection: connection ? { ...connection, gateway: traffic.groupSnapshot(user.id) } : null };
    }),
    tunnelError: state.error,
    coreStats: state.coreStats ?? null,
  };
}
