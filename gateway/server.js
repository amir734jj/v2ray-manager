import { createServer } from 'node:http';
import {
  createGatewayLogger, startResourceRecording, stopResourceRecording, parsePort,
  attachRealtime, createIpDetails, gatewayEvents, createConnectionService,
  createV2rayApi, tunnelActivitySnapshot,
} from './services';
import { createGatewayProxy } from './proxy';
import { createGatewayApp } from './app.js';
import { createDatabase, createResourceHistory } from './database';
import { discoverTrustedProxies } from './services/client-ip.js';
import { protocolPorts } from '@v2ray-manager/generator';

const logger = createGatewayLogger();
const ipDetails = createIpDetails({ logger, onChange: () => gatewayEvents.emit('status') });

const listenPort = parsePort(process.env.GATEWAY_PORT ?? '53217', 'GATEWAY_PORT');
const upstreamHost = process.env.V2RAY_UPSTREAM_HOST ?? 'v2ray';
const trustCloudflareHeaders = process.env.GATEWAY_TRUST_CLOUDFLARE_HEADERS ?? 'auto';
if (!['auto', 'true', 'false'].includes(trustCloudflareHeaders)) {
  throw new Error('GATEWAY_TRUST_CLOUDFLARE_HEADERS must be auto, true or false');
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
let shuttingDown = false;
let gatewayProxy;
let proxyDiscovery;
let tunnels;
let server;
try {
  proxyDiscovery = await discoverTrustedProxies(logger);
  gatewayProxy = createGatewayProxy({
    upstreamHost,
    ports: {
      ...protocolPorts,
      vless: process.env.V2RAY_VLESS_PORT ?? '53217',
      vmess: process.env.V2RAY_VMESS_PORT ?? '53218',
      trojan: process.env.V2RAY_TROJAN_PORT ?? '53219',
    },
    blocklist: storedBlocklist,
    logger,
    trustCloudflareHeaders: trustCloudflareHeaders === 'auto' ? 'auto' : trustCloudflareHeaders === 'true',
    trustProxy: proxyDiscovery.trustProxy,
    logTraffic: true,
  });
  tunnels = createConnectionService({
    connections,
    api: createV2rayApi(process.env.V2RAY_API_ADDRESS ?? `${upstreamHost}:10085`),
    host: process.env.V2RAY_HOST,
    logger,
    onChange: () => gatewayEvents.emit('connections'),
    disconnect: gatewayProxy.disconnectTunnel,
    listIps: gatewayProxy.listTunnelIps,
    trafficUsage: resourceHistory.trafficUsage,
    subscriptionActivity: resourceHistory.subscriptionActivity,
    destinations: resourceHistory.destinations,
    activitySnapshot: tunnelActivitySnapshot,
  });
  await tunnels.start();
} catch (error) {
  await shutdown();
  throw error;
}

const app = createGatewayApp({
  logger,
  accounts,
  tunnels,
  resourceHistory,
  ipDetails,
  secureCookies: secureCookies === 'true',
  blocklist: gatewayProxy.blocklist,
});
server = createServer(gatewayProxy.createHandler(app));
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

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  proxyDiscovery?.close();
  gatewayProxy?.stop();
  if (server) {
    await new Promise(resolve => server.close(error => {
      if (error) {
        logger.error({ err: error }, 'Gateway shutdown error');
        process.exitCode = 1;
      }
      resolve();
    }));
  }
  gatewayProxy?.close();
  await stopResourceRecording();
  try {
    await tunnels?.close();
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
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
