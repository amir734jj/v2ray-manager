import { createOutbound, createConnectionUrl } from 'v2ray-tools';

export const protocols = ['vless', 'vmess', 'trojan'];
const dnsAddresses = ['1.1.1.1', '8.8.8.8'];
const clientDnsTag = 'proxy-dns';

function configureHostnameRecovery(inbound) {
  inbound.sniffing = {
    ...inbound.sniffing,
    enabled: true,
    destOverride: ['http', 'tls'],
    metadataOnly: false,
  };
  delete inbound.sniffing.routeOnly;
}

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
  config.dns = {
    ...config.dns,
    servers: dnsAddresses.map(address => `https+local://${address}/dns-query`),
  };
  for (const outbound of config.outbounds ?? []) {
    if (outbound.protocol === 'freedom') {
      outbound.settings = { ...outbound.settings, domainStrategy: 'UseIP' };
    }
  }
  config.inbounds = config.inbounds.filter(inbound => inbound.protocol !== 'shadowsocks');
  for (const protocol of protocols) {
    const inbound = config.inbounds.find(item => item.protocol === protocol && item.streamSettings?.network === 'ws');
    if (!inbound) throw new Error(`Missing ${protocol} ws inbound; use the WebSocket server template`);
    configureHostnameRecovery(inbound);
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
  config.api = { tag: 'management-api', services: ['HandlerService', 'StatsService', 'LoggerService'] };
  config.log = { ...config.log, access: 'none' };
  config.stats = {};
  config.policy = {
    ...config.policy,
    system: { ...config.policy?.system, overrideAccessLogDest: true },
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
  const proxyTag = existing[0].tag;
  if (typeof proxyTag !== 'string' || !proxyTag.trim()) {
    throw new Error('Client proxy outbound must have a tag for tunneled DNS');
  }
  config.outbounds = config.outbounds.filter(outbound => outbound.protocol !== 'shadowsocks').map(outbound => protocols.includes(outbound.protocol)
    ? createOutbound({ ...connectionOptions(serverConfig, outbound.protocol, host), tag: outbound.tag })
    : outbound);

  config.dns = {
    ...config.dns,
    tag: clientDnsTag,
    servers: dnsAddresses.map(address => `https://${address}/dns-query`),
  };
  config.routing = {
    ...config.routing,
    rules: [
      { type: 'field', inboundTag: [clientDnsTag], outboundTag: proxyTag },
      ...(config.routing?.rules ?? []).filter(rule => (
        rule.inboundTag?.length !== 1 || rule.inboundTag[0] !== clientDnsTag
      )),
    ],
  };
  for (const inbound of config.inbounds ?? []) {
    if (['socks', 'http'].includes(inbound.protocol)) configureHostnameRecovery(inbound);
  }

  return config;
}

export function createConnectionUrls(serverConfig, host) {
  validateHost(host);
  return Object.fromEntries(protocols.map(protocol => {
    const options = connectionOptions(serverConfig, protocol, host);
    if (protocol !== 'vmess') options.tag = options.inbound.tag;
    return [protocol, createConnectionUrl(options)];
  }));
}
