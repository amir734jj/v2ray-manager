import { setImmediate } from 'node:timers/promises';
import { col, DataTypes, fn, Op, Transaction, where } from 'sequelize';
import lodash from 'lodash';
import createError from 'http-errors';

const HOUR_MS = 60 * 60 * 1000;
const READ_BATCH = 500;
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
    indexes: [{ fields: ['lastSeen'] }, { fields: ['connectionId', 'lastSeen'] }],
  });
  await Destination.sync();
  const Settings = database.define('DestinationSettings', {
    id: { type: DataTypes.INTEGER, primaryKey: true },
    retentionHours: { type: DataTypes.INTEGER, allowNull: false },
  }, {
    tableName: 'gateway_destination_settings',
    timestamps: false,
  });
  await Settings.sync();
  const [settings] = await Settings.findOrCreate({ where: { id: 1 }, defaults: { retentionHours: 24 } });
  let retentionHours = settings.retentionHours;
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

  async function listMany(ids) {
    if (!Array.isArray(ids)) throw new TypeError('Subscription IDs must be an array');
    const grouped = new Map(ids.map(id => [id, []]));
    const cutoff = clock() - retentionHours * HOUR_MS;
    // SQLite limits a compound SELECT to 500 branches.
    for (const batch of lodash.chunk([...grouped.keys()], READ_BATCH)) {
      const rows = await Destination.findAll({
        attributes: ['connectionId', 'domain', 'lastSeen'],
        where: { lastSeen: { [Op.gt]: cutoff } },
        groupedLimit: { limit: 50, on: 'connectionId', values: batch },
        order: [['lastSeen', 'DESC'], ['domain', 'ASC']],
        raw: true,
      });
      for (const row of rows) grouped.get(row.connectionId).push(row);
    }
    return new Map([...grouped].map(([id, rows]) => [id,
      lodash.orderBy(rows, [row => Number(row.lastSeen), 'domain'], ['desc', 'asc']).map(row => ({
        domain: row.domain, lastSeen: new Date(Number(row.lastSeen)).toISOString(),
      })),
    ]));
  }

  return {
    listMany,
    getRetentionHours() {
      return retentionHours;
    },
    async setRetentionHours(hours) {
      if (!Number.isSafeInteger(hours) || hours < 1 || !Number.isSafeInteger(hours * HOUR_MS)) {
        throw createError(400, 'Domain retention must be a positive whole number of hours within the supported numeric range');
      }
      await Settings.update({ retentionHours: hours }, { where: { id: 1 } });
      retentionHours = hours;
      lastPrunedAt = -Infinity;
    },
    async record(observations, ids) {
      if (!Array.isArray(observations) || !Array.isArray(ids)) {
        throw new TypeError('Destination observations and subscription IDs must be arrays');
      }
      const activeIds = new Set(ids);
      const now = clock();
      const cutoff = now - retentionHours * HOUR_MS;
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
      return (await listMany([id])).get(id);
    },
    async search({ ids, matchingIds, query, after }) {
      if (!Array.isArray(ids) || !Array.isArray(matchingIds)) {
        throw new TypeError('Destination search subscription IDs must be arrays');
      }
      if (!ids.length) return { rows: [], hasMore: false };
      const conditions = [
        { connectionId: { [Op.in]: ids } },
        { lastSeen: { [Op.gt]: clock() - retentionHours * HOUR_MS } },
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
