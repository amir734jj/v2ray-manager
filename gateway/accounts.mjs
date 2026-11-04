import { createHash, randomBytes, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { DataTypes, Op, Transaction } from 'sequelize';

const scrypt = promisify(deriveKey);
export const SESSION_SECONDS = 7 * 24 * 60 * 60;
const keyOptions = { N: 32768, maxmem: 64 * 1024 * 1024 };
const publicFields = ['id', 'username', 'active', 'admin', 'createdAt'];
const failure = (status, message) => Object.assign(new Error(message), { status });
const digest = token => createHash('sha256').update(token).digest('hex');
const publicUser = user => Object.fromEntries(publicFields.map(field => [field, user[field]]));

export function credentials(body) {
  const username = typeof body?.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = body?.password;
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username)) {
    throw failure(400, 'Username must be 3-64 characters: letters, numbers, dots, underscores or hyphens');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw failure(400, 'Password must be 12-128 characters');
  }
  return { username, password };
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64, keyOptions);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPassword(password, hash) {
  const [salt, encoded] = hash.split(':');
  const key = await scrypt(password, salt, 64, keyOptions);
  const expected = Buffer.from(encoded, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export async function createAccounts(database) {
  const User = database.define('GatewayUser', {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    username: { type: DataTypes.STRING(64), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(161), allowNull: false },
    active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    admin: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  }, { tableName: 'gateway_users' });
  const Session = database.define('GatewaySession', {
    tokenHash: { type: DataTypes.STRING(64), primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false, references: { model: User, key: 'id' }, onDelete: 'CASCADE' },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
  }, { tableName: 'gateway_sessions', timestamps: false, indexes: [{ fields: ['expiresAt'] }] });
  await User.sync();
  await Session.sync();
  const dummyHash = await hashPassword(randomBytes(32).toString('hex'));

  return {
    async register(body) {
      const { username, password } = credentials(body);
      const passwordHash = await hashPassword(password);
      try {
        return await database.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
          // Serialize bootstrap across processes: exactly one account becomes administrator.
          await database.query('SELECT pg_advisory_xact_lock(734734, 1)', { transaction });
          const first = await User.count({ transaction }) === 0;
          return publicUser(await User.create({
            username, passwordHash, active: first, admin: first,
          }, { transaction }));
        });
      } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') throw failure(409, 'Username is already registered');
        throw error;
      }
    },
    async verify(body) {
      const { username, password } = credentials(body);
      const user = await User.findOne({ where: { username } });
      const valid = await verifyPassword(password, user?.passwordHash ?? dummyHash);
      if (!user || !valid) throw failure(401, 'Invalid username or password');
      if (!user.active) throw failure(403, 'Your account is awaiting administrator activation');
      return publicUser(user);
    },
    async createSession(user) {
      const token = randomBytes(32).toString('hex');
      await Session.destroy({ where: { expiresAt: { [Op.lte]: new Date() } } });
      await Session.create({
        tokenHash: digest(token), userId: user.id,
        expiresAt: new Date(Date.now() + SESSION_SECONDS * 1000),
      });
      return token;
    },
    async authenticate(token) {
      if (!/^[a-f0-9]{64}$/.test(token ?? '')) return null;
      const session = await Session.findOne({
        where: { tokenHash: digest(token), expiresAt: { [Op.gt]: new Date() } },
      });
      if (!session) return null;
      const user = await User.findByPk(session.userId);
      return user?.active ? publicUser(user) : null;
    },
    async logout(token) {
      if (/^[a-f0-9]{64}$/.test(token ?? '')) await Session.destroy({ where: { tokenHash: digest(token) } });
    },
    list: () => User.findAll({ attributes: publicFields, order: [['createdAt', 'ASC']], raw: true }),
    async activate(id) {
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) {
        throw failure(400, 'Invalid user ID');
      }
      const user = await User.findByPk(id);
      if (!user) throw failure(404, 'User not found');
      await user.update({ active: true });
      return publicUser(user);
    },
  };
}
