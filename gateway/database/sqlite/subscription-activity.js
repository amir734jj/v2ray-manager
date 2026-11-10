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
      const next = new Map(rows.map(row => [row.id, row]));
      const changed = rows.filter(row => {
        const previous = saved.get(row.id);
        return !previous || previous.lastTrafficAt !== row.lastTrafficAt || previous.connectedSince !== row.connectedSince;
      });
      const removed = [...saved.keys()].filter(id => !next.has(id));
      if (!changed.length && !removed.length) return;
      await database.transaction(async transaction => {
        if (changed.length) {
          await Activity.bulkCreate(changed, {
            updateOnDuplicate: ['lastTrafficAt', 'connectedSince'], transaction,
          });
        }
        if (removed.length) await Activity.destroy({ where: { id: { [Op.in]: removed } }, transaction });
      });
      saved = next;
    },
    async remove(id) {
      await Activity.destroy({ where: { id } });
      saved.delete(id);
    },
  };
}
