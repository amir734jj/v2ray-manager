import { DataTypes } from 'sequelize';
import createError from 'http-errors';

const publicFields = ['id', 'name', 'maxConcurrentIps', 'enabled', 'syncStatus', 'syncError', 'createdAt'];
export const publicConnection = row => Object.fromEntries(publicFields.map(field => [field, row[field]]));

export async function initializeTunnelConnections(database, User) {
  const Connection = database.define('TunnelConnection', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    name: { type: DataTypes.STRING(128), allowNull: false },
    maxConcurrentIps: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    credential: { type: DataTypes.UUID, allowNull: false, unique: true },
    subscriptionTokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    subscriptionToken: { type: DataTypes.STRING(64), allowNull: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    syncStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
    syncError: { type: DataTypes.STRING(256), allowNull: true },
  }, { tableName: 'gateway_tunnel_connections' });
  await Connection.sync();
  const queryInterface = database.getQueryInterface();
  const columns = await queryInterface.describeTable('gateway_tunnel_connections');
  if (!columns.name || columns.userId || !columns.subscriptionToken || !columns.maxConcurrentIps) {
    await database.transaction(async transaction => {
      if (!columns.name) {
        await queryInterface.addColumn('gateway_tunnel_connections', 'name', {
          type: DataTypes.STRING(128), allowNull: false, defaultValue: 'Subscription',
        }, { transaction });
        if (columns.userId) {
          const users = await User.findAll({ attributes: ['id', 'username'], raw: true, transaction });
          for (const user of users) {
            await queryInterface.bulkUpdate('gateway_tunnel_connections', { name: user.username }, {
              userId: user.id,
            }, { transaction });
          }
        }
      }
      if (columns.userId) {
        await queryInterface.removeColumn('gateway_tunnel_connections', 'userId', { transaction });
      }
      if (!columns.subscriptionToken) {
        await queryInterface.addColumn('gateway_tunnel_connections', 'subscriptionToken', {
          type: DataTypes.STRING(64), allowNull: true,
        }, { transaction });
      }
      if (!columns.maxConcurrentIps) {
        await queryInterface.addColumn('gateway_tunnel_connections', 'maxConcurrentIps', {
          type: DataTypes.INTEGER, allowNull: false, defaultValue: 0,
        }, { transaction });
      }
    });
  }

  return {
    all: () => Connection.findAll(),
    list: () => Connection.findAll({ attributes: [...publicFields, 'subscriptionToken'], order: [['createdAt', 'ASC']], raw: true }),
    findById: id => Connection.findByPk(id),
    findByCredential: credential => Connection.findOne({ where: { credential } }),
    findBySubscriptionTokenHash: subscriptionTokenHash => Connection.findOne({ where: { subscriptionTokenHash } }),
    update: (connection, values) => connection.update(values),
    remove: connection => connection.destroy(),
    async create(values) {
      try {
        return await Connection.create(values);
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          throw createError(409, 'Subscription credentials already exist; retry creation');
        }
        throw error;
      }
    },
  };
}
