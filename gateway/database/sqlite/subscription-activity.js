import { DataTypes, Op } from 'sequelize';

export async function createSubscriptionActivity(database) {
  const Activity = database.define('SubscriptionActivity', {
    id: { type: DataTypes.UUID, primaryKey: true },
    lastTrafficAt: { type: DataTypes.STRING(24), allowNull: true },
    connectedSince: { type: DataTypes.STRING(24), allowNull: true },
  }, { tableName: 'gateway_subscription_activity', timestamps: false });
  await Activity.sync();
  let saved = new Map((await Activity.findAll({ raw: true })).map(row => [row.id, row]));

  return {
    snapshot: id => saved.get(id),
    async record(observations) {
      const rows = observations.map(({ id, lastTrafficAt, connectedSince }) => {
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
          where: rows.length ? { id: { [Op.notIn]: rows.map(row => row.id) } } : {},
          transaction,
        });
      });
      saved = new Map(rows.map(row => [row.id, row]));
    },
    async remove(id) {
      await Activity.destroy({ where: { id } });
      saved.delete(id);
    },
  };
}
