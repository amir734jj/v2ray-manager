import { Sequelize } from 'sequelize';
import { initializeAccounts } from '../services';
import { createBlocklist } from './blocked-ips.js';
import { initializeUsers } from './users.js';
import { initializeSessions } from './sessions.js';
import { initializeTunnelConnections } from './tunnel-connections.js';

export async function createDatabase(url) {
  if (!url) throw new Error('DATABASE_URL is required for accounts and the IP blocklist');
  const database = new Sequelize(url, {
    dialect: 'postgres',
    logging: false,
    pool: { max: 2, min: 0, acquire: 5000, idle: 30000 },
    dialectOptions: {
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
    },
  });
  try {
    const users = await initializeUsers(database);
    const sessions = await initializeSessions(database, users.model);
    const accounts = await initializeAccounts({ users, sessions });
    return {
      blocklist: await createBlocklist(database),
      accounts,
      connections: await initializeTunnelConnections(database, users.model),
      close: () => database.close(),
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
