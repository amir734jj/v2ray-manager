import { DataTypes, Op } from 'sequelize';
import lodash from 'lodash';

export async function createSubscriptionActivity(database) {
  const Activity = database.define('SubscriptionActivity', {
    id: { type: DataTypes.UUID, primaryKey: true },
    lastTrafficAt: { type: DataTypes.STRING(24), allowNull: true },
    connectedSince: { type: DataTypes.STRING(24), allowNull: true },
  }, { tableName: 'gateway_subscription_activity', timestamps: false });
  await Activity.sync();
  const initialRows = await Activity.findAll({ raw: true });
  if (!Array.isArray(initialRows)) throw new TypeError('Invalid saved subscription activity rows');
  let saved = new Map(lodash.map(initialRows, row => [row.id, row]));

  return {
    snapshot: id => saved.get(id),
    async record(observations) {
      if (!Array.isArray(observations)) throw new TypeError('Subscription activity observations must be an array');
      const rows = lodash.map(observations, ({ id, lastTrafficAt, connectedSince }) => {
        const previous = saved.get(id);
        for (const value of [lastTrafficAt, connectedSince]) {
          if (value !== null && (typeof value !== 'string' || new Date(value).toISOString() !== value)) {
            throw new Error('Invalid subscription activity timestamp');
          }
        }
        return {
          id,
          lastTrafficAt: lastTrafficAt ?? previous?.lastTrafficAt ?? null,
          connectedSince: connectedSince ?? previous?.connectedSince ?? null,
        };
      });
      await database.transaction(async transaction => {
        if (rows.length) {
          await Activity.bulkCreate(rows, {
            updateOnDuplicate: ['lastTrafficAt', 'connectedSince'], transaction,
          });
        }
        await Activity.destroy({
          where: rows.length ? { id: { [Op.notIn]: lodash.map(rows, 'id') } } : {},
          transaction,
        });
      });
      saved = new Map(lodash.map(rows, row => [row.id, row]));
    },
    async remove(id) {
      await Activity.destroy({ where: { id } });
      saved.delete(id);
    },
  };
}
