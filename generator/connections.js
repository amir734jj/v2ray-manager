import { createOutbound, createConnectionUrl } from 'v2ray-tools';

export const protocols = ['vless', 'vmess', 'trojan'];

export function validateHost(host) {
  if (!host || host === 'YOUR_SERVER_IP') {
    throw new Error('Public hostnames are required');
  }
  const url = new URL(`https://${host}`);
  if (url.hostname !== host || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Server address must be a hostname without a scheme, port, or path');
  }
  return host;
}

export function configureServerTransports(config) {
  config.inbounds = config.inbounds.filter(inbound => inbound.protocol !== 'shadowsocks');
  for (const protocol of protocols) {
    const inbound = config.inbounds.find(item => item.protocol === protocol && item.streamSettings?.network === 'ws');
    if (!inbound) throw new Error(`Missing ${protocol} ws inbound; use the WebSocket server template`);
    inbound.streamSettings = {
      network: 'ws',
      security: 'none',
      wsSettings: { path: `/${protocol}` },
    };
  }
  return config;
}

export function configureManagedServer(config) {
  configureServerTransports(config);
  for (const inbound of config.inbounds.filter(item => protocols.includes(item.protocol))) {
    inbound.settings.clients = [];
  }
  config.api = { tag: 'management-api', services: ['HandlerService', 'StatsService'] };
  config.stats = {};
  config.policy = {
    ...config.policy,
    levels: {
      ...config.policy?.levels,
      '0': { ...config.policy?.levels?.['0'], statsUserUplink: true, statsUserDownlink: true },
    },
  };
  config.inbounds.push({
    tag: 'management-api-inbound',
    listen: '0.0.0.0',
    port: 10085,
    protocol: 'dokodemo-door',
    settings: { address: '127.0.0.1' },
  });
  config.routing.rules.unshift({
    type: 'field', inboundTag: ['management-api-inbound'], outboundTag: 'management-api',
  });
  return config;
}

function connectionOptions(serverConfig, protocol, host) {
  const inbound = serverConfig.inbounds.find(
    item => item.protocol === protocol && item.streamSettings?.network === 'ws',
  );
  if (!inbound) throw new Error(`Missing ${protocol} ws inbound`);
  return {
    inbound,
    address: host,
    port: 443,
    tag: `${protocol}-ws`,
    streamSettings: {
      network: 'ws',
      security: 'tls',
      tlsSettings: { serverName: host },
      wsSettings: {
        path: inbound.streamSettings.wsSettings.path,
        headers: { Host: host },
      },
    },
  };
}

export function configureClient(config, serverConfig, host) {
  validateHost(host);
  const existing = (config.outbounds ?? []).filter(outbound => protocols.includes(outbound.protocol));
  if (existing.length === 0) throw new Error('Client has no supported proxy outbound');
  if (existing.some(outbound => outbound.streamSettings?.network !== 'ws')) {
    throw new Error('Client proxy outbounds must use WebSocket; regenerate from templates');
  }
  config.outbounds = config.outbounds.filter(outbound => outbound.protocol !== 'shadowsocks').map(outbound => protocols.includes(outbound.protocol)
    ? createOutbound({ ...connectionOptions(serverConfig, outbound.protocol, host), tag: outbound.tag })
    : outbound);

  return config;
}

export function createConnectionUrls(serverConfig, host) {
  validateHost(host);
  return Object.fromEntries(protocols.map(protocol => {
    const options = connectionOptions(serverConfig, protocol, host);
    if (protocol === 'vmess') {
      options.tag = options.inbound.tag ?? options.tag;
      return [protocol, `${createConnectionUrl(options)}#${encodeURIComponent(options.tag)}`];
    }
    options.tag = options.inbound.tag;
    return [protocol, createConnectionUrl(options)];
  }));
}
