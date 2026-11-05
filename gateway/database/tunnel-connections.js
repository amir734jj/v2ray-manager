import { DataTypes } from 'sequelize';
import createError from 'http-errors';

const publicFields = ['id', 'userId', 'enabled', 'syncStatus', 'syncError', 'createdAt'];
export const publicConnection = row => Object.fromEntries(publicFields.map(field => [field, row[field]]));

export async function initializeTunnelConnections(database, User) {
  const Connection = database.define('TunnelConnection', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, unique: true, references: { model: User, key: 'id' } },
    credential: { type: DataTypes.UUID, allowNull: false, unique: true },
    subscriptionTokenHash: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    syncStatus: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'pending' },
    syncError: { type: DataTypes.STRING(256), allowNull: true },
  }, { tableName: 'gateway_tunnel_connections' });
  await Connection.sync();

  return {
    all: () => Connection.findAll(),
    list: () => Connection.findAll({ attributes: publicFields, order: [['createdAt', 'ASC']], raw: true }),
    findById: id => Connection.findByPk(id),
    findByUserId: userId => Connection.findOne({ where: { userId } }),
    findByCredential: credential => Connection.findOne({ where: { credential } }),
    findBySubscriptionTokenHash: subscriptionTokenHash => Connection.findOne({ where: { subscriptionTokenHash } }),
    update: (connection, values) => connection.update(values),
    async create(values) {
      try {
        return await Connection.create(values);
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
          throw createError(409, 'This user already has a connection');
        }
        throw error;
      }
    },
  };
}
