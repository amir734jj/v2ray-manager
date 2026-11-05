import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DataTypes } from 'sequelize';
import { createConnectionUrls, protocols, validateHost } from '@v2ray-manager/generator';

const failure = (status, message) => Object.assign(new Error(message), { status });
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const publicFields = ['id', 'userId', 'enabled', 'syncStatus', 'syncError', 'createdAt'];
const publicConnection = row => Object.fromEntries(publicFields.map(field => [field, row[field]]));

export async function initializeConnections(database, User) {
  const Connection = database.define('TunnelConnection', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: User, key: 'id' } },
    credential: { type: DataTypes.UUID, allowNull: false, unique: true },
    subscriptionTokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    syncStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
    syncError: { type: DataTypes.STRING(256), allowNull: true },
  }, { tableName: 'gateway_tunnel_connections' });
  await Connection.sync();
  return Connection;
}

export function parseTunnelPath(path) {
  const match = /^\/(vless|vmess|trojan)\/([a-f0-9-]+)$/.exec(path);
  return match && uuidPattern.test(match[2]) ? { protocol: match[1], credential: match[2] } : null;
}

export function disconnectTunnelSockets(sockets, id) {
  for (const [socket, connection] of sockets) {
    if (connection?.client.tunnelId === id) {
      connection.blocked = true;
      socket.destroy();
    }
  }
}

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

export function createConnectionService({ Connection, User, api, host, disconnect, logger, onChange = () => {} }) {
  validateHost(host);
  let queue = Promise.resolve();
  let stopping = false;
  let timer;
  let reconciliationError = null;
  const blocked = new Set();
  const appliedCredentials = new Map();

  async function guarded(operation) {
    try {
      return await operation();
    } catch (error) {
      if (Number.isInteger(error.status)) throw error;
      logger.error({ errorName: error.name, errorCode: error.original?.code ?? error.code }, 'Tunnel management operation failed');
      throw failure(503, 'Tunnel management failed; check gateway logs. Changes may have been saved.');
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
    if (!uuidPattern.test(id)) throw failure(400, 'Invalid connection ID');
    const row = await Connection.findByPk(id);
    if (!row) throw failure(404, 'Connection not found');
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
        await row.update({ syncStatus: 'applied', syncError: null });
        onChange();
      }
    } catch (error) {
      const message = 'Live V2Ray update failed; access is blocked until synchronization succeeds.';
      await row.update({ syncStatus: 'error', syncError: message });
      disconnect(row.id);
      logger.error({
        connectionId: row.id, errorName: error.name, errorCode: error.original?.code ?? error.code,
      }, 'Tunnel credential synchronization failed');
      onChange();
      throw failure(503, message);
    }
  }

  async function reconcile() {
    const rows = await Connection.findAll();
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

  return {
    async start() { await scheduleReconciliation(); },
    async close() {
      stopping = true;
      clearTimeout(timer);
      await queue;
      api.close();
    },
    async list() {
      return guarded(async () => ({
        connections: await Connection.findAll({ attributes: publicFields, order: [['createdAt', 'ASC']], raw: true }),
        error: reconciliationError,
      }));
    },
    create(userId) {
      return exclusive(async () => {
        if (!uuidPattern.test(userId)) throw failure(400, 'Invalid user ID');
        const owner = await User.findByPk(userId);
        if (!owner) throw failure(404, 'User not found');
        if (!owner.active) throw failure(409, 'Activate the dashboard account before creating its connection');
        if (await Connection.findOne({ where: { userId } })) throw failure(409, 'This user already has a connection');
        const token = randomBytes(32).toString('hex');
        let row;
        try {
          row = await Connection.create({
            id: randomUUID(), userId, credential: randomUUID(), subscriptionTokenHash: tokenHash(token),
            enabled: true, syncStatus: 'pending',
          });
        } catch (error) {
          if (error.name === 'SequelizeUniqueConstraintError') throw failure(409, 'This user already has a connection');
          throw error;
        }
        onChange();
        await apply(row);
        return { connection: publicConnection(row), subscriptionUrl: subscriptionUrl(token) };
      });
    },
    change(id, action) {
      return exclusive(async () => {
        if (!['pause', 'resume', 'reset', 'subscription'].includes(action)) throw failure(400, 'Unknown connection action');
        const row = await find(id);
        const token = ['reset', 'subscription'].includes(action) ? randomBytes(32).toString('hex') : null;
        if (action === 'subscription') {
          await row.update({ subscriptionTokenHash: tokenHash(token) });
        } else {
          blocked.add(id);
          try {
            await row.update({
              ...(action === 'reset' ? { credential: randomUUID(), subscriptionTokenHash: tokenHash(token) } : { enabled: action === 'resume' }),
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
        const row = await Connection.findOne({ where: { credential: parsed.credential } });
        if (!row || !row.enabled || row.syncStatus !== 'applied' || blocked.has(row.id)) return null;
        return { id: row.id, userId: row.userId, protocol: parsed.protocol };
      });
    },
    async subscription(token) {
      if (!/^[a-f0-9]{64}$/.test(token)) throw failure(404, 'Subscription not found');
      return guarded(async () => {
        const row = await Connection.findOne({ where: { subscriptionTokenHash: tokenHash(token) } });
        if (!row) throw failure(404, 'Subscription not found');
        if (!row.enabled) throw failure(403, 'This connection is paused');
        if (row.syncStatus !== 'applied' || blocked.has(row.id)) throw failure(503, 'This connection is awaiting synchronization');
        return subscriptionContent(row, host);
      });
    },
  };
}
