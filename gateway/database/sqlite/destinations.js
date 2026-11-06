import { setImmediate } from 'node:timers/promises';
import { col, DataTypes, fn, Op, Transaction, where } from 'sequelize';
import lodash from 'lodash';

const RETENTION_MS = 24 * 60 * 60 * 1000;
const WRITE_BATCH = 500;
const PRUNE_INTERVAL_MS = 60 * 1000;

export async function createDestinations(database, clock = Date.now) {
  const Destination = database.define('SubscriptionDestination', {
    connectionId: { type: DataTypes.UUID, primaryKey: true },
    domain: { type: DataTypes.STRING(253), primaryKey: true },
    lastSeen: { type: DataTypes.BIGINT, allowNull: false },
  }, {
    tableName: 'gateway_subscription_destinations',
    timestamps: false,
    indexes: [
      { fields: ['lastSeen'] },
      { fields: ['connectionId', 'lastSeen'] },
      {
        name: 'gateway_subscription_destinations_recent',
        fields: [{ name: 'lastSeen', order: 'DESC' }, 'connectionId', 'domain'],
      },
    ],
  });
  await Destination.sync();
  let lastPrunedAt = -Infinity;
  let previousIds = null;

  async function prune(where) {
    let count;
    do {
      count = await database.transaction({ type: Transaction.TYPES.IMMEDIATE }, async transaction => {
        const rows = await Destination.findAll({
          attributes: ['connectionId', 'domain'], where, limit: WRITE_BATCH, raw: true, transaction,
        });
        if (rows.length) {
          await Destination.destroy({
            where: { [Op.or]: rows }, transaction,
          });
        }
        return rows.length;
      });
      if (count === WRITE_BATCH) await setImmediate();
    } while (count === WRITE_BATCH);
  }

  return {
    async record(observations, ids) {
      if (!Array.isArray(observations) || !Array.isArray(ids)) {
        throw new TypeError('Destination observations and subscription IDs must be arrays');
      }
      const activeIds = new Set(ids);
      const now = clock();
      const cutoff = now - RETENTION_MS;
      const rows = lodash.filter(observations, row => activeIds.has(row.connectionId) && row.lastSeen > cutoff);
      for (const batch of lodash.chunk(rows, WRITE_BATCH)) {
        await database.transaction({ type: Transaction.TYPES.IMMEDIATE }, transaction => {
          return Destination.bulkCreate(batch, { updateOnDuplicate: ['lastSeen'], transaction });
        });
        await setImmediate();
      }
      if (now - lastPrunedAt >= PRUNE_INTERVAL_MS) {
        await prune({ lastSeen: { [Op.lte]: cutoff } });
        lastPrunedAt = now;
      }
      if (!previousIds || previousIds.size !== activeIds.size || lodash.some(ids, id => !previousIds.has(id))) {
        await prune(ids.length ? { connectionId: { [Op.notIn]: ids } } : {});
        previousIds = activeIds;
      }
    },
    async list(id) {
      const rows = await Destination.findAll({
        attributes: ['domain', 'lastSeen'],
        where: { connectionId: id, lastSeen: { [Op.gt]: clock() - RETENTION_MS } },
        order: [['lastSeen', 'DESC'], ['domain', 'ASC']],
        limit: 50,
        raw: true,
      });
      return lodash.map(rows, row => ({
        domain: row.domain, lastSeen: new Date(Number(row.lastSeen)).toISOString(),
      }));
    },
    async search({ ids, matchingIds, query, after }) {
      if (!Array.isArray(ids) || !Array.isArray(matchingIds)) {
        throw new TypeError('Destination search subscription IDs must be arrays');
      }
      if (!ids.length) return { rows: [], hasMore: false };
      const conditions = [
        { connectionId: { [Op.in]: ids } },
        { lastSeen: { [Op.gt]: clock() - RETENTION_MS } },
      ];
      if (query) {
        conditions.push({
          [Op.or]: [
            where(fn('instr', col('domain'), query), { [Op.gt]: 0 }),
            { connectionId: { [Op.in]: matchingIds } },
          ],
        });
      }
      if (after) {
        conditions.push({ lastSeen: { [Op.lte]: after.lastSeen } }, {
          [Op.or]: [
            { lastSeen: { [Op.lt]: after.lastSeen } },
            { lastSeen: after.lastSeen, connectionId: { [Op.gt]: after.connectionId } },
            { lastSeen: after.lastSeen, connectionId: after.connectionId, domain: { [Op.gt]: after.domain } },
          ],
        });
      }
      const rows = await Destination.findAll({
        attributes: ['connectionId', 'domain', 'lastSeen'],
        where: { [Op.and]: conditions },
        order: [['lastSeen', 'DESC'], ['connectionId', 'ASC'], ['domain', 'ASC']],
        limit: 51,
        raw: true,
      });
      return { rows: lodash.take(rows, 50), hasMore: rows.length > 50 };
    },
    async remove(id) {
      await Destination.destroy({ where: { connectionId: id } });
    },
  };
}
