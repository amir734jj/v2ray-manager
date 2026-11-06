import { createHash, randomUUID } from 'node:crypto';
import createError from 'http-errors';
import lodash from 'lodash';
import { createConnectionUrls, protocols, validateHost } from '@v2ray-manager/generator';
import { publicConnection } from '../database/postgres/tunnel-connections.js';
import { parseTunnelPath } from '../proxy/paths.js';
import { createDestinationMonitor } from './destinations.js';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tokenHash = token => createHash('sha256').update(token).digest('hex');

function subscriptionName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 128) {
    throw createError(400, 'Subscription name must contain 1-128 characters');
  }
  return name.trim();
}

function validateIpLimit(value) {
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) {
    throw createError(400, 'Concurrent IP limit must be a whole number from 0 to 2147483647; use 0 for unlimited');
  }
  return value;
}

export function subscriptionContent(connection, host) {
  const config = {
    inbounds: lodash.map(protocols, protocol => ({
      protocol,
      tag: `${protocol}-${connection.id.slice(0, 8)}`,
      settings: { clients: [protocol === 'trojan' ? { password: connection.credential } : { id: connection.credential, alterId: 0 }] },
      streamSettings: { network: 'ws', wsSettings: { path: `/${protocol}/${connection.credential}` } },
    })),
  };
  const links = lodash.sortBy(lodash.values(createConnectionUrls(config, host)));
  return Buffer.from(links.join('\n') + '\n').toString('base64');
}

export function createConnectionService({ connections, api, host, disconnect, listIps, trafficUsage, subscriptionActivity, destinations, activitySnapshot, logger, onChange = () => {} }) {
  validateHost(host);
  let queue = Promise.resolve();
  let stopping = false;
  let timer;
  let statsTimer;
  let pendingStats = null;
  let reconciliationError = null;
  let activityError = null;
  let coreStats = { status: 'loading', sampledAt: null, uptimeSeconds: null, error: null };
  let coreCounters = new Map();
  const blocked = new Set();
  const appliedCredentials = new Map();
  const authorizations = new Map();
  const authorizationCredentials = new Map();
  let authorizationReady = false;
  const destinationMonitor = createDestinationMonitor({
    api, store: destinations, listIds: async () => lodash.map(await listRows(), 'id'), logger, onChange,
  });

  function revokeAuthorization(id) {
    const credential = authorizationCredentials.get(id);
    if (credential !== undefined) authorizations.delete(credential);
    authorizationCredentials.delete(id);
  }

  function cacheAuthorization(row) {
    revokeAuthorization(row.id);
    if (stopping || !row.enabled || row.syncStatus !== 'applied') return;
    authorizations.set(row.credential, { id: row.id, maxConcurrentIps: row.maxConcurrentIps });
    authorizationCredentials.set(row.id, row.credential);
  }

  function clearAuthorizations() {
    authorizationReady = false;
    authorizations.clear();
    authorizationCredentials.clear();
  }

  async function guarded(operation) {
    try {
      return await operation();
    } catch (error) {
      if (Number.isInteger(error.status)) throw error;
      logger.error({ errorName: error.name, errorCode: error.original?.code ?? error.code }, 'Tunnel management operation failed');
      throw createError(503, 'Tunnel management failed; check gateway logs. Changes may have been saved.');
    }
  }

  function exclusive(operation) {
    const result = queue.then(() => guarded(operation));
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function subscriptionUrl(token) {
    return `https://${host}/subscriptions/${token}`;
  }

  async function find(id) {
    if (!uuidPattern.test(id)) throw createError(400, 'Invalid connection ID');
    const row = await connections.findById(id);
    if (!row) {
      revokeAuthorization(id);
      disconnect(id);
      throw createError(404, 'Connection not found');
    }
    return row;
  }

  async function apply(row) {
    try {
      if (appliedCredentials.get(row.id) !== row.credential || !row.enabled) {
        for (const protocol of protocols) await api.remove(protocol, row);
      }
      if (row.enabled) {
        for (const protocol of protocols) await api.add(protocol, row);
      }
      appliedCredentials.set(row.id, row.credential);
      if (row.syncStatus !== 'applied' || row.syncError) {
        await connections.update(row, { syncStatus: 'applied', syncError: null });
        onChange();
      }
      cacheAuthorization(row);
    } catch (error) {
      const message = 'Live V2Ray update failed; access is blocked until synchronization succeeds.';
      revokeAuthorization(row.id);
      disconnect(row.id);
      logger.error({
        connectionId: row.id, errorName: error.name, errorCode: error.original?.code ?? error.code,
      }, 'Tunnel credential synchronization failed');
      await connections.update(row, { syncStatus: 'error', syncError: message });
      onChange();
      throw createError(503, message);
    }
  }

  async function reconcile() {
    const rows = await connections.all();
    if (!Array.isArray(rows)) throw new TypeError('Invalid subscription reconciliation rows');
    const desired = new Map(lodash.map(rows, row => [row.id, row]));
    for (const [id, credential] of [...authorizationCredentials]) {
      const row = desired.get(id);
      if (!row || row.credential !== credential || !row.enabled || row.syncStatus !== 'applied') {
        revokeAuthorization(id);
        disconnect(id);
      } else {
        cacheAuthorization(row);
      }
    }
    let failed = false;
    for (const row of rows) {
      try {
        await apply(row);
      } catch (error) {
        if (error.status !== 503) throw error;
        failed = true;
      }
    }
    authorizationReady = !stopping;
    reconciliationError = failed ? 'Some tunnel credentials could not be synchronized; affected connections are blocked.' : null;
    onChange();
  }

  async function scheduleReconciliation() {
    if (stopping) return;
    try {
      await exclusive(reconcile);
    } catch (error) {
      clearAuthorizations();
      reconciliationError = 'Tunnel reconciliation failed; check gateway logs.';
      logger.error({ err: error }, 'Tunnel reconciliation failed');
      onChange();
    } finally {
      if (!stopping) {
        timer = setTimeout(scheduleReconciliation, 15000);
        timer.unref();
      }
    }
  }

  async function listRows() {
    const rows = await connections.list();
    if (!Array.isArray(rows)) throw new TypeError('Invalid subscription list rows');
    return rows;
  }

  async function collectStats(resetId) {
    try {
      const sample = await api.stats();
      const counters = new Map();
      for (const counter of sample.counters) {
        const match = /^user>>>connection-([a-f0-9-]+)>>>traffic>>>(uplink|downlink)$/.exec(counter.name);
        if (!match || !uuidPattern.test(match[1])) continue;
        const value = BigInt(counter.value);
        if (value < 0n) throw new RangeError('V2Ray returned a negative user traffic counter');
        const current = counters.get(match[1]) ?? {};
        current[match[2] === 'uplink' ? 'uploadBytes' : 'downloadBytes'] = value.toString();
        counters.set(match[1], current);
      }
      const rows = await listRows();
      const saved = await trafficUsage.record(sample, counters, lodash.map(rows, 'id'), resetId);
      coreCounters = saved.counters;
      coreStats = { status: 'ready', sampledAt: sample.sampledAt, uptimeSeconds: sample.uptimeSeconds, error: null };
    } catch (error) {
      coreStats = {
        ...coreStats,
        status: 'error',
        error: 'Traffic totals could not be collected or saved; displayed totals may be stale. Check gateway logs, the embedded metrics store, and the V2Ray StatsService.',
      };
      logger.warn({ err: error }, 'V2Ray traffic collection or persistence failed');
      onChange();
      return false;
    }
    onChange();
    return true;
  }

  async function collectActivity() {
    try {
      const rows = await listRows();
      await subscriptionActivity.record(lodash.map(rows, row => {
        const activity = activitySnapshot(row.id);
        return {
          id: row.id, lastTrafficAt: activity.lastTrafficAt,
          connectedSince: activity.lastConnectedSince,
        };
      }));
      activityError = null;
    } catch (error) {
      activityError = 'Subscription activity timestamps could not be saved; check gateway logs. Saved timestamps may be stale.';
      logger.warn({ err: error }, 'Subscription activity persistence failed');
    }
    onChange();
  }

  async function scheduleStats() {
    if (stopping) return;
    pendingStats = exclusive(async () => {
      await destinationMonitor.flush();
      await collectActivity();
      await collectStats();
    });
    try {
      await pendingStats;
    } finally {
      pendingStats = null;
      if (!stopping) {
        statsTimer = setTimeout(scheduleStats, 5000);
        statsTimer.unref();
      }
    }
  }

  return {
    async start() {
      const saved = trafficUsage.snapshot();
      coreCounters = saved.counters;
      coreStats = { ...coreStats, sampledAt: saved.sampledAt, uptimeSeconds: saved.uptimeSeconds };
      destinationMonitor.start();
      await Promise.all([scheduleReconciliation(), scheduleStats()]);
    },
    async close() {
      stopping = true;
      clearAuthorizations();
      clearTimeout(timer);
      clearTimeout(statsTimer);
      destinationMonitor.stop();
      await Promise.all([queue, pendingStats]);
      await destinationMonitor.flush();
      await collectActivity();
      api.close();
    },
    async list() {
      return guarded(async () => {
        const rows = await listRows();
        return {
          connections: await Promise.all(lodash.map(rows, async row => {
            const connectedIps = listIps(row.id);
            return {
              ...publicConnection(row),
              activeIps: connectedIps.length,
              connectedIps,
              savedActivity: subscriptionActivity.snapshot(row.id),
              subscriptionUrl: row.subscriptionToken ? subscriptionUrl(row.subscriptionToken) : null,
              coreTraffic: coreStats.sampledAt === null ? null : coreCounters.get(row.id) ?? { uploadBytes: '0', downloadBytes: '0' },
              recentDestinations: await destinations.list(row.id),
            };
          })),
          error: lodash.compact([reconciliationError, activityError]).join(' ') || null,
          coreStats: { ...coreStats },
          destinationStats: destinationMonitor.status(),
        };
      });
    },
    create(name, maxConcurrentIps = 0) {
      return exclusive(async () => {
        const normalizedName = subscriptionName(name);
        validateIpLimit(maxConcurrentIps);
        const token = randomUUID();
        const row = await connections.create({
          id: randomUUID(), name: normalizedName, credential: randomUUID(), subscriptionTokenHash: tokenHash(token), subscriptionToken: token,
          enabled: true, syncStatus: 'pending', maxConcurrentIps,
        });
        onChange();
        await apply(row);
        return { connection: publicConnection(row), subscriptionUrl: subscriptionUrl(token) };
      });
    },
    change(id, action, body) {
      return exclusive(async () => {
        if (!['pause', 'resume', 'reset', 'subscription', 'delete', 'limits', 'rename', 'reset-stats'].includes(action)) throw createError(400, 'Unknown connection action');
        const changesAuthorization = ['pause', 'resume', 'reset', 'delete', 'limits'].includes(action);
        if (changesAuthorization) blocked.add(id);
        try {
          const row = await find(id);
          const token = ['reset', 'subscription'].includes(action) ? randomUUID() : null;
          if (action === 'reset-stats') {
            if (!await collectStats(id)) {
              throw createError(503, 'Traffic totals could not be reset; check gateway logs and retry. Previously saved totals are unchanged.');
            }
          } else if (action === 'rename') {
            await connections.update(row, { name: subscriptionName(body?.name) });
          } else if (action === 'limits') {
            const maxConcurrentIps = validateIpLimit(body?.maxConcurrentIps);
            revokeAuthorization(id);
            await connections.update(row, { maxConcurrentIps });
            cacheAuthorization(row);
          } else if (action === 'subscription') {
            await connections.update(row, { subscriptionTokenHash: tokenHash(token), subscriptionToken: token });
          } else {
            revokeAuthorization(id);
            await connections.update(row, {
              ...(action === 'reset' ? {
                credential: randomUUID(), subscriptionTokenHash: tokenHash(token), subscriptionToken: token,
              } : { enabled: action === 'resume' }),
              syncStatus: 'pending', syncError: null,
            });
            if (action !== 'resume') disconnect(id);
            onChange();
            await apply(row);
            if (action === 'delete') {
              await connections.remove(row);
              await trafficUsage.remove(id);
              await subscriptionActivity.remove(id);
              await destinations.remove(id);
              appliedCredentials.delete(id);
              coreCounters.delete(id);
            }
          }
          onChange();
          if (action === 'delete') return { deleted: true };
          return { connection: publicConnection(row), ...(token ? { subscriptionUrl: subscriptionUrl(token) } : {}) };
        } catch (error) {
          if (changesAuthorization && (!Number.isInteger(error.status) || error.status >= 500)) revokeAuthorization(id);
          throw error;
        } finally {
          if (changesAuthorization) blocked.delete(id);
        }
      });
    },
    authorize(path) {
      const parsed = parseTunnelPath(path);
      if (!parsed) return null;
      if (!authorizationReady || stopping) throw createError(503, 'Tunnel authorization is unavailable; awaiting synchronization');
      const authorization = authorizations.get(parsed.credential);
      if (!authorization || blocked.has(authorization.id)) return null;
      return { ...authorization, protocol: parsed.protocol };
    },
    async subscription(token) {
      if (!uuidPattern.test(token) && !/^[a-f0-9]{64}$/.test(token)) throw createError(404, 'Subscription not found');
      return guarded(async () => {
        const row = await connections.findBySubscriptionTokenHash(tokenHash(token));
        if (!row) throw createError(404, 'Subscription not found');
        if (!row.enabled) throw createError(403, 'This connection is paused');
        if (row.syncStatus !== 'applied' || blocked.has(row.id)) throw createError(503, 'This connection is awaiting synchronization');
        return subscriptionContent(row, host);
      });
    },
  };
}
