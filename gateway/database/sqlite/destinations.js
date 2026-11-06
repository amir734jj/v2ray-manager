import { DataTypes, Op } from 'sequelize';
import lodash from 'lodash';

const RETENTION_MS = 24 * 60 * 60 * 1000;

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

  return {
    async record(observations, ids) {
      if (!Array.isArray(observations) || !Array.isArray(ids)) {
        throw new TypeError('Destination observations and subscription IDs must be arrays');
      }
      const activeIds = new Set(ids);
      const cutoff = clock() - RETENTION_MS;
      const rows = lodash.filter(observations, row => activeIds.has(row.connectionId) && row.lastSeen > cutoff);
      await database.transaction(async transaction => {
        if (rows.length) {
          await Destination.bulkCreate(rows, { updateOnDuplicate: ['lastSeen'], transaction });
        }
        await Destination.destroy({
          where: ids.length ? {
            [Op.or]: [
              { lastSeen: { [Op.lte]: cutoff } },
              { connectionId: { [Op.notIn]: ids } },
            ],
          } : {},
          transaction,
        });
      });
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
    async remove(id) {
      await Destination.destroy({ where: { connectionId: id } });
    },
  };
}
