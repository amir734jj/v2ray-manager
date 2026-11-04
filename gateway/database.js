import { col, DataTypes, fn, Op, Sequelize, Transaction, where } from 'sequelize';
import { normalizeIp } from './blocklist.js';
import { initializeAccounts } from './accounts.js';

export const MAX_BLOCKED_IPS = 1000;

export async function createDatabase(url) {
  if (!url) throw new Error('DATABASE_URL is required for accounts and the IP blocklist');
  const database = new Sequelize(url, {
    dialect: 'postgres',
    logging: false,
    pool: { max: 2, min: 0, acquire: 5000, idle: 30000 },
    dialectOptions: {
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
    },
  });
  try {
    return {
      blocklist: await createBlocklist(database),
      accounts: await initializeAccounts(database),
      close: () => database.close(),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}

function decodeBlockedIps(rows) {
  if (rows.length > MAX_BLOCKED_IPS) throw new RangeError(`Blocklist is limited to ${MAX_BLOCKED_IPS} IPs`);
  const addresses = new Set(rows.map(row => normalizeIp(row.ip)));
  if (addresses.size !== rows.length) throw new Error('Database contains equivalent duplicate IP addresses');
  return addresses;
}

async function loadBlockedIps(BlockedIp, transaction) {
  const rows = await BlockedIp.findAll({
    attributes: ['ip'],
    limit: MAX_BLOCKED_IPS + 1,
    raw: true,
    transaction,
  });
  return decodeBlockedIps(rows);
}

async function changeBlockedIp(state, value, adding) {
  const ip = normalizeIp(value);
  if (state.busy) throw Object.assign(new Error('Another blocklist update is in progress; retry shortly'), { status: 409 });
  state.busy = true;
  try {
    const next = await state.database.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async transaction => {
      const addresses = await loadBlockedIps(state.BlockedIp, transaction);
      if (adding) {
        if (!addresses.has(ip) && addresses.size >= MAX_BLOCKED_IPS) {
          throw new RangeError(`Blocklist is limited to ${MAX_BLOCKED_IPS} IPs`);
        }
        if (!addresses.has(ip)) await state.BlockedIp.create({ ip }, { transaction });
        addresses.add(ip);
      } else {
        await state.BlockedIp.destroy({ where: { ip }, transaction });
        addresses.delete(ip);
      }
      return addresses;
    });
    state.blocked = next;
    return ip;
  } catch (error) {
    if (error.original?.code === '40001') {
      throw Object.assign(new Error('Another blocklist update conflicted; retry shortly', { cause: error }), { status: 409 });
    }
    throw error;
  } finally {
    state.busy = false;
  }
}

async function createBlocklist(database) {
  const BlockedIp = database.define('BlockedIp', {
    ip: { type: DataTypes.INET, primaryKey: true },
  }, {
    tableName: 'gateway_ip_blocklist',
    timestamps: false,
  });
  await BlockedIp.sync();
  try {
    await database.getQueryInterface().addConstraint(BlockedIp.getTableName(), {
      fields: ['ip'],
      type: 'check',
      name: 'gateway_ip_blocklist_host_check',
      where: {
        [Op.or]: [
          { [Op.and]: [where(fn('family', col('ip')), 4), where(fn('masklen', col('ip')), 32)] },
          { [Op.and]: [where(fn('family', col('ip')), 6), where(fn('masklen', col('ip')), 128)] },
        ],
      },
    });
  } catch (error) {
    if (error.original?.code !== '42710') throw error;
  }
  const state = { database, BlockedIp, blocked: await loadBlockedIps(BlockedIp), busy: false };

  return {
    list: () => [...state.blocked].sort(),
    has: value => state.blocked.has(normalizeIp(value)),
    block: value => changeBlockedIp(state, value, true),
    unblock: value => changeBlockedIp(state, value, false),
  };
}
