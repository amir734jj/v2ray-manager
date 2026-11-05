import { createHash, randomUUID } from 'node:crypto';
import createError from 'http-errors';
import { createConnectionUrls, protocols, validateHost } from '@v2ray-manager/generator';
import { publicConnection } from '../database/tunnel-connections.js';
import { parseTunnelPath } from '../proxy/paths.js';

const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tokenHash = token => createHash('sha256').update(token).digest('hex');

export function subscriptionContent(connection, host) {
  const config = {
    inbounds: protocols.map(protocol => ({
      protocol,
      tag: `${protocol}-${connection.id.slice(0, 8)}`,
      settings: { clients: [protocol === 'trojan' ? { password: connection.credential } : { id: connection.credential, alterId: 0 }] },
      streamSettings: { network: 'ws', wsSettings: { path: `/${protocol}/${connection.credential}` } },
    })),
  };
  return Buffer.from(Object.values(createConnectionUrls(config, host)).join('\n') + '\n').toString('base64');
}

export function createConnectionService({ connections, users, api, host, disconnect, logger, onChange = () => {} }) {
  validateHost(host);
  let queue = Promise.resolve();
  let stopping = false;
  let timer;
  let statsTimer;
  let pendingStats = null;
  let reconciliationError = null;
  let coreStats = { status: 'loading', sampledAt: null, uptimeSeconds: null, error: null };
  let coreCounters = new Map();
  const blocked = new Set();
  const appliedCredentials = new Map();

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
    if (!row) throw createError(404, 'Connection not found');
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
    } catch (error) {
      const message = 'Live V2Ray update failed; access is blocked until synchronization succeeds.';
      await connections.update(row, { syncStatus: 'error', syncError: message });
      disconnect(row.id);
      logger.error({
        connectionId: row.id, errorName: error.name, errorCode: error.original?.code ?? error.code,
      }, 'Tunnel credential synchronization failed');
      onChange();
      throw createError(503, message);
    }
  }

  async function reconcile() {
    const rows = await connections.all();
    let failed = false;
    for (const row of rows) {
      try {
        await apply(row);
      } catch (error) {
        if (error.status !== 503) throw error;
        failed = true;
      }
    }
    reconciliationError = failed ? 'Some tunnel credentials could not be synchronized; affected connections are blocked.' : null;
    onChange();
  }

  async function scheduleReconciliation() {
    if (stopping) return;
    try {
      await exclusive(reconcile);
    } catch (error) {
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

  async function collectStats() {
    try {
      const sample = await api.stats();
      const counters = new Map();
      for (const counter of sample.counters) {
        const match = /^user>>>connection-([a-f0-9-]+)>>>traffic>>>(uplink|downlink)$/.exec(counter.name);
        if (!match || !uuidPattern.test(match[1])) continue;
        const value = BigInt(counter.value);
        if (value < 0n) throw new RangeError('V2Ray returned a negative user traffic counter');
        const current = counters.get(match[1]) ?? { uploadBytes: '0', downloadBytes: '0' };
        current[match[2] === 'uplink' ? 'uploadBytes' : 'downloadBytes'] = value.toString();
        counters.set(match[1], current);
      }
      coreCounters = counters;
      coreStats = { status: 'ready', sampledAt: sample.sampledAt, uptimeSeconds: sample.uptimeSeconds, error: null };
    } catch (error) {
      coreStats = {
        ...coreStats,
        status: 'error',
        error: 'V2Ray user statistics are unavailable; previously collected totals may be stale. Check the internal API and ensure StatsService and user counters are enabled.',
      };
      logger.warn({ err: error }, 'V2Ray user statistics failed');
    }
    onChange();
  }

  async function scheduleStats() {
    if (stopping) return;
    pendingStats = collectStats();
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
    async start() { await Promise.all([scheduleReconciliation(), scheduleStats()]); },
    async close() {
      stopping = true;
      clearTimeout(timer);
      clearTimeout(statsTimer);
      await Promise.all([queue, pendingStats]);
      api.close();
    },
    async list() {
      return guarded(async () => {
        const rows = await connections.list();
        return {
          connections: rows.map(row => ({
            ...publicConnection(row),
            subscriptionUrl: row.subscriptionToken ? subscriptionUrl(row.subscriptionToken) : null,
            coreTraffic: coreStats.sampledAt === null ? null : coreCounters.get(row.id) ?? { uploadBytes: '0', downloadBytes: '0' },
          })),
          error: reconciliationError,
          coreStats: { ...coreStats },
        };
      });
    },
    create(userId) {
      return exclusive(async () => {
        if (!uuidPattern.test(userId)) throw createError(400, 'Invalid user ID');
        const owner = await users.findById(userId);
        if (!owner) throw createError(404, 'User not found');
        if (!owner.active) throw createError(409, 'Activate the dashboard account before creating its connection');
        if (await connections.findByUserId(userId)) throw createError(409, 'This user already has a connection');
        const token = randomUUID();
        const row = await connections.create({
          id: randomUUID(), userId, credential: randomUUID(), subscriptionTokenHash: tokenHash(token), subscriptionToken: token,
          enabled: true, syncStatus: 'pending',
        });
        onChange();
        await apply(row);
        return { connection: publicConnection(row), subscriptionUrl: subscriptionUrl(token) };
      });
    },
    change(id, action) {
      return exclusive(async () => {
        if (!['pause', 'resume', 'reset', 'subscription'].includes(action)) throw createError(400, 'Unknown connection action');
        const row = await find(id);
        const token = ['reset', 'subscription'].includes(action) ? randomUUID() : null;
        if (action === 'subscription') {
          await connections.update(row, { subscriptionTokenHash: tokenHash(token), subscriptionToken: token });
        } else {
          blocked.add(id);
          try {
            await connections.update(row, {
              ...(action === 'reset' ? {
                credential: randomUUID(), subscriptionTokenHash: tokenHash(token), subscriptionToken: token,
              } : { enabled: action === 'resume' }),
              syncStatus: 'pending', syncError: null,
            });
            if (action !== 'resume') disconnect(id);
            onChange();
            await apply(row);
          } finally {
            blocked.delete(id);
          }
        }
        onChange();
        return { connection: publicConnection(row), ...(token ? { subscriptionUrl: subscriptionUrl(token) } : {}) };
      });
    },
    async authorize(path) {
      const parsed = parseTunnelPath(path);
      if (!parsed) return null;
      return guarded(async () => {
        const row = await connections.findByCredential(parsed.credential);
        if (!row || !row.enabled || row.syncStatus !== 'applied' || blocked.has(row.id)) return null;
        return { id: row.id, userId: row.userId, protocol: parsed.protocol };
      });
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
