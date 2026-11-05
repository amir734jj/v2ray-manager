import { createServer } from 'node:http';
import {
  createGatewayLogger, startResourceRecording, stopResourceRecording, parsePort,
  attachRealtime, createIpDetails, gatewayEvents, createConnectionService,
  createV2rayApi,
} from './services/index.js';
import { createGatewayProxy } from './proxy/index.js';
import { createGatewayApp } from './app.js';
import { createDatabase } from './database/index.js';
import { createResourceHistory } from './database/resource-history.js';

const logger = createGatewayLogger();
const ipDetails = createIpDetails({ logger, onChange: () => gatewayEvents.emit('status') });

const listenPort = parsePort(process.env.GATEWAY_PORT ?? '53217', 'GATEWAY_PORT');
const upstreamHost = process.env.V2RAY_UPSTREAM_HOST ?? 'v2ray';
const trustCloudflareHeaders = process.env.GATEWAY_TRUST_CLOUDFLARE_HEADERS ?? 'false';
if (!['true', 'false'].includes(trustCloudflareHeaders)) {
  throw new Error('GATEWAY_TRUST_CLOUDFLARE_HEADERS must be true or false');
}
const secureCookies = process.env.GATEWAY_SECURE_COOKIES ?? 'true';
if (!['true', 'false'].includes(secureCookies)) {
  throw new Error('GATEWAY_SECURE_COOKIES must be true or false');
}
const { blocklist: storedBlocklist, accounts, connections, close: closeDatabase } = await createDatabase(process.env.DATABASE_URL);
let resourceHistory;
try {
  resourceHistory = await createResourceHistory(process.env.GATEWAY_METRICS_PATH ?? './data/resource-history');
} catch (error) {
  await closeDatabase();
  throw error;
}
startResourceRecording(resourceHistory, logger);
const gatewayProxy = createGatewayProxy({
  upstreamHost,
  ports: {
    vless: process.env.V2RAY_VLESS_PORT ?? '53217',
    vmess: process.env.V2RAY_VMESS_PORT ?? '53218',
    trojan: process.env.V2RAY_TROJAN_PORT ?? '53219',
  },
  blocklist: storedBlocklist,
  logger,
  trustCloudflareHeaders: trustCloudflareHeaders === 'true',
});
const tunnels = createConnectionService({
  connections,
  users: accounts.users,
  api: createV2rayApi(process.env.V2RAY_API_ADDRESS ?? `${upstreamHost}:10085`),
  host: process.env.V2RAY_HOST,
  logger,
  onChange: () => gatewayEvents.emit('users'),
  disconnect: gatewayProxy.disconnectTunnel,
});
await tunnels.start();

const app = createGatewayApp({
  logger,
  accounts,
  tunnels,
  resourceHistory,
  ipDetails,
  secureCookies: secureCookies === 'true',
  blocklist: gatewayProxy.blocklist,
});
const server = createServer(gatewayProxy.createHandler(app));
gatewayProxy.attach(server, { tunnels });

attachRealtime(server, {
  accounts, tunnels, blocklist: storedBlocklist, secureCookies: secureCookies === 'true', logger, ipDetails,
});

function serverError(error) {
  logger.error({ err: error }, 'Gateway server error');
  process.exitCode = 1;
  shutdown();
}
server.on('error', serverError);

server.listen(listenPort, '0.0.0.0', () => {
  logger.info({ transport: 'ws', port: listenPort }, `WebSocket gateway listening on port ${listenPort}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  gatewayProxy.stop();
  server.close(async error => {
    gatewayProxy.close();
    if (error) {
      logger.error({ err: error }, 'Gateway shutdown error');
      process.exitCode = 1;
    }
    await stopResourceRecording();
    try {
      await tunnels.close();
    } catch (error) {
      logger.error({ err: error }, 'Tunnel management shutdown error');
      process.exitCode = 1;
    }
    try {
      await resourceHistory.close();
    } catch (historyError) {
      logger.error({ err: historyError }, 'Gateway resource history shutdown error');
      process.exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (databaseError) {
      logger.error({ err: databaseError }, 'Gateway PostgreSQL shutdown error');
      process.exitCode = 1;
    }
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
