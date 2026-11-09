import grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import lodash from 'lodash';
import { fileURLToPath } from 'node:url';
import { protocolPorts, protocols } from '@v2ray-manager/generator';

const root = protobuf.loadSync(fileURLToPath(new URL('./v2ray-api.proto', import.meta.url)));
const namespace = 'v2ray.core.app.proxyman.command';
const type = name => root.lookupType(`${namespace}.${name}`);
const encode = (name, value) => Buffer.from(type(name).encode(value).finish());
function rpcMethod(service, method, request, response) {
  return {
    path: `/${service}/${method}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: value => encode(request, value),
    requestDeserialize: value => type(request).decode(value),
    responseSerialize: value => encode(response, value),
    responseDeserialize: value => type(response).decode(value),
  };
}
const HandlerClient = grpc.makeGenericClientConstructor({
  alterInbound: rpcMethod(`${namespace}.HandlerService`, 'AlterInbound', 'AlterInboundRequest', 'AlterInboundResponse'),
  addInbound: rpcMethod(`${namespace}.HandlerService`, 'AddInbound', 'AddInboundRequest', 'AddInboundResponse'),
  removeInbound: rpcMethod(`${namespace}.HandlerService`, 'RemoveInbound', 'RemoveInboundRequest', 'RemoveInboundResponse'),
}, 'HandlerService');
const StatsClient = grpc.makeGenericClientConstructor({
  queryStats: rpcMethod('v2ray.core.app.stats.command.StatsService', 'QueryStats', 'QueryStatsRequest', 'QueryStatsResponse'),
  getSysStats: rpcMethod('v2ray.core.app.stats.command.StatsService', 'GetSysStats', 'SysStatsRequest', 'SysStatsResponse'),
}, 'StatsService');
const LoggerClient = grpc.makeGenericClientConstructor({
  followLog: {
    ...rpcMethod('v2ray.core.app.log.command.LoggerService', 'FollowLog', 'FollowLogRequest', 'FollowLogResponse'),
    responseStream: true,
  },
}, 'LoggerService');
const typedMessage = (name, value) => ({ typeUrl: `types.v2fly.org/${name}`, value });
const missingInbound = 'not enough information for making a decision';

export function createV2rayApi(address) {
  if (!address) throw new Error('V2RAY_API_ADDRESS is required');
  const client = new HandlerClient(address, grpc.credentials.createInsecure());
  const statsClient = new StatsClient(address, grpc.credentials.createInsecure());
  const loggerClient = new LoggerClient(address, grpc.credentials.createInsecure());
  const shadowsocks = new Map();
  function handlerCall(method, request, expectedMessage) {
    return new Promise((resolve, reject) => {
      client[method](request, { deadline: Date.now() + 5000 }, error => {
        if (!error) return resolve(true);
        if (error.code === grpc.status.UNKNOWN && error.details === expectedMessage) return resolve(false);
        reject(error);
      });
    });
  }
  function readStats(method, request) {
    return new Promise((resolve, reject) => {
      statsClient[method](request, { deadline: Date.now() + 5000 }, (error, response) => {
        if (error) reject(error);
        else resolve(response);
      });
    });
  }
  function alter(protocol, operation, value, expectedMessage) {
    if (!protocols.includes(protocol)) throw new TypeError('Unsupported tunnel protocol');
    return handlerCall('alterInbound', {
      tag: `${protocol}-${protocolPorts[protocol]}`,
      operation: typedMessage(`${namespace}.${operation}`, encode(operation, value)),
    }, expectedMessage);
  }
  async function addShadowsocks(connection) {
    let state = shadowsocks.get(connection.id);
    if (state?.applied && state.credential === connection.credential) return;
    if (!state) {
      const used = new Set([...shadowsocks.values()].map(item => item.port));
      let port = 20000;
      while (used.has(port) && port < protocolPorts.vless) port++;
      if (port >= protocolPorts.vless) throw new Error('No private Shadowsocks inbound ports available');
      state = { port, applied: false };
      shadowsocks.set(connection.id, state);
    }
    state.applied = false;
    const tag = `shadowsocks-${connection.id}`;
    await handlerCall('removeInbound', { tag }, missingInbound);
    await handlerCall('addInbound', {
      inbound: {
        tag,
        receiverSettings: typedMessage('v2ray.core.app.proxyman.ReceiverConfig', encode('ReceiverConfig', {
          portRange: { from: state.port, to: state.port },
          listen: { ip: Buffer.from([0, 0, 0, 0]) },
          streamSettings: {
            protocolName: 'websocket',
            transportSettings: [{
              protocolName: 'websocket',
              settings: typedMessage('v2ray.core.transport.internet.websocket.Config',
                encode('WebSocketConfig', { path: '/shadowsocks' })),
            }],
          },
          sniffingSettings: { enabled: true, destinationOverride: ['http', 'tls'] },
        })),
        proxySettings: typedMessage('v2ray.core.proxy.shadowsocks.ServerConfig', encode('ShadowsocksServerConfig', {
          user: {
            email: `connection-${connection.id}`,
            account: typedMessage('v2ray.core.proxy.shadowsocks.Account',
              encode('ShadowsocksAccount', { password: connection.credential, cipherType: 2 })), // AES_256_GCM.
          },
        })),
      },
    });
    state.credential = connection.credential;
    state.applied = true;
  }
  return {
    followLogs() {
      return loggerClient.followLog({});
    },
    shadowsocksPort(id) {
      const state = shadowsocks.get(id);
      return state?.applied ? state.port : undefined;
    },
    async add(protocol, connection) {
      if (protocol === 'shadowsocks') return addShadowsocks(connection);
      const email = `connection-${connection.id}`;
      const added = await alter(protocol, 'AddUserOperation', {
        user: {
          email,
          account: typedMessage(`v2ray.core.proxy.${protocol}.Account`,
            encode('Credential', { value: connection.credential })),
        },
      }, `proxy/${protocol}${protocol === 'vmess' ? '/inbound' : ''}: User ${email} already exists.`);
      // Fresh VLESS users also identify a restarted core with no dynamic inbounds.
      if (added && protocol === 'vless') {
        const state = shadowsocks.get(connection.id);
        if (state) state.applied = false;
      }
    },
    async remove(protocol, connection) {
      if (protocol === 'shadowsocks') {
        await handlerCall('removeInbound', { tag: `shadowsocks-${connection.id}` }, missingInbound);
        shadowsocks.delete(connection.id);
        return;
      }
      const email = `connection-${connection.id}`;
      return alter(protocol, 'RemoveUserOperation', { email },
        `proxy/${protocol}${protocol === 'vmess' ? '/inbound' : ''}: User ${email} not found.`);
    },
    async stats() {
      const beforeStart = Date.now();
      const before = await readStats('getSysStats', {});
      const beforeEnd = Date.now();
      const response = await readStats('queryStats', { pattern: 'user>>>connection-', reset: false });
      if (!Array.isArray(response.stat)) throw new TypeError('V2Ray returned invalid traffic counters');
      const afterStart = Date.now();
      const after = await readStats('getSysStats', {});
      const afterEnd = Date.now();
      // Uptime is rounded to seconds; RPC timings bound the actual process start.
      const bootWindow = {
        min: Math.max(beforeStart - (before.uptime + 1) * 1000, afterStart - (after.uptime + 1) * 1000),
        max: Math.min(beforeEnd - before.uptime * 1000, afterEnd - after.uptime * 1000),
      };
      if (after.uptime < before.uptime || bootWindow.min > bootWindow.max) {
        throw new Error('V2Ray restarted while collecting statistics; retrying on the next sample');
      }
      return {
        sampledAt: new Date(afterEnd).toISOString(),
        uptimeSeconds: after.uptime,
        bootWindow,
        counters: lodash.map(response.stat, counter => ({ name: counter.name, value: counter.value.toString() })),
      };
    },
    close() {
      client.close();
      statsClient.close();
      loggerClient.close();
    },
  };
}
