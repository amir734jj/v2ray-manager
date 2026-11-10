import { randomUUID } from 'node:crypto';
import lodash from 'lodash';
import { LRUCache } from 'lru-cache';
import { createTrafficMeter } from './traffic.js';
import { createResourceMeter } from './resources.js';
import { listAccounts } from './accounts.js';
import { gatewayEvents } from './events.js';
import { protocols } from '@v2ray-manager/generator';

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
const counters = lodash.map(protocols, protocol => ({
  transport: 'ws', protocol, active: 0, total: 0, errors: 0,
}));
const countries = new Map();
const pendingCountries = new LRUCache({ max: 2000, ttl: 24 * 60 * 60 * 1000 });
const clients = new Map();
const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
export const MAX_CLIENT_DETAILS = 1000;
export const MAX_USER_AGENT_LENGTH = 256;

function connectionTotals() {
  return {
    active: lodash.sumBy(counters, 'active'),
    total: lodash.sumBy(counters, 'total'),
    errors: lodash.sumBy(counters, 'errors'),
  };
}

function countryCode(value) {
  return typeof value === 'string' && /^(?:[A-Z]{2}|T1)$/.test(value) && value !== 'XX'
    ? value : 'unknown';
}

function countryCounter(code) {
  if (!countries.has(code)) {
    countries.set(code, {
      code,
      name: code === 'unknown' ? 'Unknown' : code === 'T1' ? 'Tor' : countryNames.of(code),
      active: 0, total: 0, errors: 0,
    });
  }
  return countries.get(code);
}

function countryRecord(country, ip) {
  const code = countryCode(country);
  if (code === 'unknown' && ip) {
    const existing = pendingCountries.get(ip);
    if (existing) return existing;
  }
  const record = { row: countryCounter(code), active: 0, total: 0, errors: 0 };
  if (code === 'unknown' && ip) pendingCountries.set(ip, record);
  return record;
}

function resolveCountries(ipDetails) {
  if (!ipDetails) return;
  for (const [ip, record] of pendingCountries) {
    const details = ipDetails.lookup(ip);
    const code = details.status === 'ready' ? countryCode(details.countryCode) : 'unknown';
    if (code === 'unknown') continue;
    const row = countryCounter(code);
    for (const field of ['active', 'total', 'errors']) {
      record.row[field] -= record[field];
      row[field] += record[field];
    }
    record.row = row;
    pendingCountries.delete(ip);
  }
}

export function trackConnection(transport, protocol, connection, {
  country, ip, userAgent, tunnelId, connectionId = randomUUID(), connectedAt = new Date().toISOString(), bufferedBytes = 0,
} = {}) {
  const counter = lodash.find(counters, item => item.transport === transport && item.protocol === protocol);
  const countryStats = countryRecord(country, ip);
  const client = clients.size < MAX_CLIENT_DETAILS ? {
    connectionId,
    tunnelId,
    ip: ip ?? 'unknown',
    protocol,
    transport,
    userAgent: typeof userAgent === 'string' && userAgent.trim()
      ? userAgent.slice(0, MAX_USER_AGENT_LENGTH) : 'Unknown',
    connectedAt,
  } : null;
  const clientTraffic = traffic.track(connection, bufferedBytes, Boolean(client), { groupId: tunnelId, connectedAt });
  if (client) clients.set(client, { traffic: clientTraffic, country: countryStats });
  for (const row of [counter, countryStats, countryStats.row]) {
    row.active++;
    row.total++;
  }
  gatewayEvents.emit('status');
  if (tunnelId) gatewayEvents.emit('connections');
  connection.once('close', () => {
    counter.active--;
    countryStats.active--;
    countryStats.row.active--;
    if (client) clients.delete(client);
    gatewayEvents.emit('status');
    if (tunnelId) gatewayEvents.emit('connections');
  });
  let failed = false;
  return () => {
    if (!failed) {
      counter.errors++;
      countryStats.errors++;
      countryStats.row.errors++;
      gatewayEvents.emit('status');
    }
    failed = true;
  };
}

export function snapshot(ipDetails, includeSubscriptions = false) {
  resolveCountries(ipDetails);
  const totals = connectionTotals();
  const activeClients = lodash.map([...clients], ([client, { traffic: clientTraffic, country }]) => {
    const { tunnelId, ...details } = client;
    return {
      ...details,
      countryCode: country.row.code,
      countryName: country.row.name,
      ...(includeSubscriptions ? { subscriptionId: tunnelId ?? null } : {}),
      traffic: clientTraffic.snapshot(),
      elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(client.connectedAt)) / 1000)),
    };
  });
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
    clientGroups: lodash.map([...groups.values()], group => ({
      ip: group.ip,
      active: group.active,
      countries: [...group.countries.values()].sort((a, b) => a.code.localeCompare(b.code)),
      protocols: lodash.sortBy([...group.protocols]),
      traffic: group.traffic,
      ipDetails: ipDetails ? ipDetails.lookup(group.ip) : { status: 'unavailable' },
    })).sort((a, b) => a.ip.localeCompare(b.ip)),
  };
}

export function statusSnapshot(blocklist, ipDetails, admin = false) {
  return { ...snapshot(ipDetails, admin), blockedIPs: blocklist ? blocklist.list() : [], blocklistAvailable: Boolean(blocklist) };
}

export async function usersSnapshot(accounts) {
  return { users: await listAccounts(accounts) };
}

export function tunnelActivitySnapshot(id) {
  return traffic.groupSnapshot(id);
}

export async function connectionsSnapshot(tunnels) {
  const state = tunnels ? await tunnels.list() : { connections: [], error: 'Tunnel management is unavailable' };
  if (!Array.isArray(state.connections)) throw new TypeError('Invalid subscription snapshot');
  return {
    connections: lodash.map(state.connections, ({ savedActivity, ...connection }) => {
      const gateway = traffic.groupSnapshot(connection.id);
      return {
        ...connection,
        gateway: {
          ...gateway,
          lastTrafficAt: gateway.lastTrafficAt ?? savedActivity?.lastTrafficAt ?? null,
          lastConnectedSince: gateway.lastConnectedSince ?? savedActivity?.connectedSince ?? null,
        },
      };
    }),
    tunnelError: state.error,
    coreStats: state.coreStats ?? null,
    destinationStats: state.destinationStats ?? null,
    destinationRetentionHours: state.destinationRetentionHours ?? null,
  };
}
