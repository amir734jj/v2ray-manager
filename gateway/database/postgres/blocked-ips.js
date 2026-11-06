import { col, DataTypes, fn, Op, Transaction, where } from 'sequelize';
import createError from 'http-errors';
import lodash from 'lodash';
import { normalizeIp } from '../../services';

export const MAX_BLOCKED_IPS = 1000;

function decodeBlockedIps(rows) {
  if (rows.length > MAX_BLOCKED_IPS) throw new RangeError(`Blocklist is limited to ${MAX_BLOCKED_IPS} IPs`);
  const addresses = new Set(lodash.map(rows, row => normalizeIp(row.ip)));
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
  if (state.busy) throw createError(409, 'Another blocklist update is in progress; retry shortly');
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
      throw createError(409, new Error('Another blocklist update conflicted; retry shortly', { cause: error }));
    }
    throw error;
  } finally {
    state.busy = false;
  }
}

export async function createBlocklist(database) {
  const BlockedIp = database.define('BlockedIp', {
    ip: { type: DataTypes.INET, primaryKey: true },
  }, {
    tableName: 'gateway_ip_blocklist',
    timestamps: false,
    hooks: {
      async afterSync(options) {
        const queryInterface = database.getQueryInterface();
        const table = BlockedIp.getTableName();
        const name = 'gateway_ip_blocklist_host_check';
        const queryOptions = { transaction: options.transaction, logging: options.logging };
        const constraints = await queryInterface.showConstraint(table, name, queryOptions);
        if (!Array.isArray(constraints)) throw new TypeError('Invalid blocklist constraints');
        if (lodash.some(constraints, constraint => constraint.constraintName === name)) return;
        await queryInterface.addConstraint(table, {
          ...queryOptions,
          fields: ['ip'],
          type: 'check',
          name,
          where: {
            [Op.or]: [
              { [Op.and]: [where(fn('family', col('ip')), 4), where(fn('masklen', col('ip')), 32)] },
              { [Op.and]: [where(fn('family', col('ip')), 6), where(fn('masklen', col('ip')), 128)] },
            ],
          },
        });
      },
    },
  });
  await BlockedIp.sync();
  const state = { database, BlockedIp, blocked: await loadBlockedIps(BlockedIp), busy: false };

  return {
    list: () => lodash.sortBy([...state.blocked]),
    has: value => state.blocked.has(normalizeIp(value)),
    block: value => changeBlockedIp(state, value, true),
    unblock: value => changeBlockedIp(state, value, false),
  };
}
