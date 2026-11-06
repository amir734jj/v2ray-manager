import { DataTypes } from 'sequelize';
import createError from 'http-errors';
import lodash from 'lodash';

const publicFields = ['id', 'name', 'maxConcurrentIps', 'enabled', 'syncStatus', 'syncError', 'createdAt'];
export const publicConnection = row => lodash.zipObject(publicFields, lodash.map(publicFields, field => row[field]));

export async function initializeTunnelConnections(database) {
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
