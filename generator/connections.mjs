import { createOutbound, createConnectionUrl } from 'v2ray-tools';

export const protocols = ['vless', 'vmess', 'trojan', 'shadowsocks'];

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
  config.inbounds = config.inbounds.filter(
    inbound => inbound.streamSettings?.network !== 'grpc' && !inbound.tag?.includes('-grpc-'),
  );
  for (const protocol of protocols) {
    const inbound = config.inbounds.find(item => item.protocol === protocol && item.streamSettings?.network === 'ws')
      ?? config.inbounds.find(item => item.protocol === protocol);
    if (!inbound) throw new Error(`Missing ${protocol} inbound`);
    inbound.streamSettings = {
      network: 'ws',
      security: 'none',
      wsSettings: { path: `/${protocol}` },
    };
    if (protocol === 'shadowsocks') inbound.settings.network = 'tcp';
  }
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
  const configuredProtocols = [...new Set(existing.map(outbound => outbound.protocol))];
  if (configuredProtocols.length === 0) throw new Error('Client has no supported proxy outbound');
  const originalTags = new Map(existing.map(outbound => [outbound.tag, outbound.protocol]));
  const staticOutbounds = config.outbounds.filter(outbound => !protocols.includes(outbound.protocol));
  config.outbounds = [
    ...configuredProtocols.map(protocol => createOutbound(connectionOptions(serverConfig, protocol, host))),
    ...staticOutbounds,
  ];

  if (configuredProtocols.length === 1 && configuredProtocols[0] === 'shadowsocks') {
    for (const inbound of config.inbounds ?? []) {
      if (inbound.protocol === 'socks') inbound.settings = { ...inbound.settings, udp: false };
    }
  }

  config.routing ??= {};
  const rules = config.routing.rules ?? [];
  for (const rule of rules) {
    const protocol = originalTags.get(rule.outboundTag)
      ?? configuredProtocols.find(item => rule.balancerTag === `${item}-auto`);
    if (!protocol) continue;
    delete rule.balancerTag;
    rule.outboundTag = `${protocol}-ws`;
  }
  const defaultTag = `${configuredProtocols[0]}-ws`;
  if (!rules.some(rule => rule.outboundTag === defaultTag
    && Object.keys(rule).every(key => ['type', 'network', 'outboundTag'].includes(key)))) {
    rules.push({
      type: 'field',
      network: configuredProtocols[0] === 'shadowsocks' ? 'tcp' : 'tcp,udp',
      outboundTag: defaultTag,
    });
  }
  config.routing.rules = rules;
  const balancers = (config.routing.balancers ?? [])
    .filter(balancer => !configuredProtocols.some(protocol => balancer.tag === `${protocol}-auto`));
  if (balancers.length) config.routing.balancers = balancers;
  else delete config.routing.balancers;
  delete config.observatory;
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
