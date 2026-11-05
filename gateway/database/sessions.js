import { DataTypes, Op } from 'sequelize';

export async function initializeSessions(database, User) {
  const Session = database.define('GatewaySession', {
    tokenHash: { type: DataTypes.STRING(64), primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: 'id' }, onDelete: 'CASCADE' },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  }, { tableName: 'gateway_sessions', timestamps: false, indexes: [{ fields: ['expiresAt'] }] });
  await Session.sync();

  return {
    async create(tokenHash, userId, seconds) {
      await Session.destroy({ where: { expiresAt: { [Op.lte]: new Date() } } });
      return Session.create({ tokenHash, userId, expiresAt: new Date(Date.now() + seconds * 1000) });
    },
    findActive: tokenHash => Session.findOne({
      where: { tokenHash, expiresAt: { [Op.gt]: new Date() } },
    }),
    revoke: tokenHash => Session.destroy({ where: { tokenHash } }),
  };
}
