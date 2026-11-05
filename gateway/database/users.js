import { DataTypes, Transaction } from 'sequelize';
import createError from 'http-errors';

const publicFields = ['id', 'username', 'active', 'admin', 'createdAt'];
export const publicUser = user => Object.fromEntries(publicFields.map(field => [field, user[field]]));

export async function initializeUsers(database) {
  const User = database.define('GatewayUser', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(161), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, { tableName: 'gateway_users' });
  await User.sync();

  return {
    model: User,
    findById: id => User.findByPk(id),
    findByUsername: username => User.findOne({ where: { username } }),
    list: () => User.findAll({ attributes: publicFields, order: [['createdAt', 'ASC']], raw: true }),
    async register({ username, passwordHash }) {
      for (let attempt = 1; ; attempt++) {
        try {
          return await database.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.SERIALIZABLE }, async transaction => {
            const first = await User.count({ transaction }) === 0;
            return User.create({ username, passwordHash, active: first, admin: first }, { transaction });
          });
        } catch (error) {
          if (error.original?.code === '40001') {
            if (attempt < 3) continue;
            throw createError(409, new Error('Concurrent registration conflict; please try again', { cause: error }));
          }
          if (error.name === 'SequelizeUniqueConstraintError') throw createError(409, 'Username is already registered');
          throw error;
        }
      }
    },
    async upgradePassword(id, previousHash, passwordHash) {
      const [updated] = await User.update(
        { passwordHash },
        { where: { id, passwordHash: previousHash, active: true } },
      );
      return updated;
    },
    async activate(id) {
      const user = await User.findByPk(id);
      if (!user) return null;
      await user.update({ active: true });
      return user;
    },
  };
}
