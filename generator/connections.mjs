import { createOutbound, createConnectionUrl } from 'v2ray-tools';

export const protocols = ['vless', 'vmess', 'trojan', 'shadowsocks'];
export const grpcPorts = {
  vless: 53317,
  vmess: 53318,
  trojan: 53319,
  shadowsocks: 53320,
};

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

function findInbound(config, protocol, network) {
  return config.inbounds.find(
    inbound => inbound.protocol === protocol && inbound.streamSettings?.network === network,
  );
}

export function configureServerTransports(config) {
  const additions = [];
  for (const protocol of protocols) {
    const protocolInbounds = config.inbounds.filter(inbound => inbound.protocol === protocol);
    const wsInbound = findInbound(config, protocol, 'ws')
      ?? protocolInbounds.find(inbound => !inbound.tag?.includes('-grpc-'))
      ?? protocolInbounds[0];
    if (!wsInbound) throw new Error(`Missing ${protocol} inbound`);

    wsInbound.streamSettings = {
      network: 'ws',
      security: 'none',
      wsSettings: { path: `/${protocol}` },
    };
    if (protocol === 'shadowsocks') wsInbound.settings.network = 'tcp';

    let grpcInbound = findInbound(config, protocol, 'grpc')
      ?? protocolInbounds.find(inbound => inbound.tag?.includes('-grpc-'));
    if (!grpcInbound) {
      grpcInbound = structuredClone(wsInbound);
      grpcInbound.port = grpcPorts[protocol];
      additions.push(grpcInbound);
    }
    grpcInbound.tag = `${protocol}-grpc-${grpcInbound.port}`;
    grpcInbound.streamSettings = {
      network: 'grpc',
      security: 'none',
      grpcSettings: { serviceName: `${protocol}-grpc` },
    };
    if (protocol === 'shadowsocks') grpcInbound.settings.network = 'tcp';
  }
  config.inbounds.push(...additions);
  return config;
}

function publicStream(inbound, host) {
  const stream = {
    network: inbound.streamSettings.network,
    security: 'tls',
    tlsSettings: { serverName: host },
  };
  if (stream.network === 'ws') {
    stream.wsSettings = {
      path: inbound.streamSettings.wsSettings.path,
      headers: { Host: host },
    };
  } else if (stream.network === 'grpc') {
    stream.grpcSettings = {
      serviceName: inbound.streamSettings.grpcSettings.serviceName,
    };
  } else {
    throw new Error(`Unsupported public transport: ${stream.network}`);
  }
  return stream;
}

function connectionOptions(serverConfig, protocol, network, host) {
  const inbound = findInbound(serverConfig, protocol, network);
  if (!inbound) throw new Error(`Missing ${protocol} ${network} inbound`);
  return {
    inbound,
    address: host,
    port: 443,
    tag: `${protocol}-${network}`,
    streamSettings: publicStream(inbound, host),
  };
}

export function configureClient(config, serverConfig, wsHost, grpcHost) {
  validateHost(wsHost);
  validateHost(grpcHost);
  const existingProxyOutbounds = (config.outbounds ?? []).filter(outbound => protocols.includes(outbound.protocol));
  const configuredProtocols = [...new Set(existingProxyOutbounds.map(outbound => outbound.protocol))];
  if (configuredProtocols.length === 0) throw new Error('Client has no supported proxy outbound');

  const originalTags = new Map(
    existingProxyOutbounds.map(outbound => [outbound.tag, outbound.protocol]),
  );
  const staticOutbounds = config.outbounds.filter(outbound => !protocols.includes(outbound.protocol));
  const automaticOutbounds = configuredProtocols.flatMap(protocol => [
    createOutbound(connectionOptions(serverConfig, protocol, 'ws', wsHost)),
    createOutbound(connectionOptions(serverConfig, protocol, 'grpc', grpcHost)),
  ]);
  config.outbounds = [...automaticOutbounds, ...staticOutbounds];

  if (configuredProtocols.length === 1 && configuredProtocols[0] === 'shadowsocks') {
    for (const inbound of config.inbounds ?? []) {
      if (inbound.protocol === 'socks') inbound.settings = { ...inbound.settings, udp: false };
    }
  }

  config.routing ??= {};
  const rules = config.routing.rules ?? [];
  let hasAutomaticDefault = false;
  for (const rule of rules) {
    const protocol = originalTags.get(rule.outboundTag);
    if (!protocol) continue;
    delete rule.outboundTag;
    rule.balancerTag = `${protocol}-auto`;
    hasAutomaticDefault ||= protocol === configuredProtocols[0];
  }
  if (!hasAutomaticDefault) {
    rules.push({
      type: 'field',
      network: configuredProtocols[0] === 'shadowsocks' ? 'tcp' : 'tcp,udp',
      balancerTag: `${configuredProtocols[0]}-auto`,
    });
  }
  config.routing.rules = rules;
  config.routing.balancers = [
    ...(config.routing.balancers ?? []).filter(balancer => !balancer.tag?.endsWith('-auto')),
    ...configuredProtocols.map(protocol => ({
      tag: `${protocol}-auto`,
      selector: [`${protocol}-ws`, `${protocol}-grpc`],
      strategy: { type: 'leastping', settings: {} },
      fallbackTag: `${protocol}-ws`,
    })),
  ];
  config.observatory = {
    subjectSelector: automaticOutbounds.map(outbound => outbound.tag),
    probeURL: 'https://cp.cloudflare.com/generate_204',
    probeInterval: '30s',
  };
  return config;
}

export function createConnectionUrls(serverConfig, wsHost, grpcHost) {
  validateHost(wsHost);
  validateHost(grpcHost);
  return Object.fromEntries(
    [['ws', wsHost], ['grpc', grpcHost]].map(([network, host]) => [
      network,
      Object.fromEntries(
        protocols.filter(protocol => network !== 'grpc' || protocol !== 'shadowsocks')
          .map(protocol => {
            const options = connectionOptions(serverConfig, protocol, network, host);
            if (protocol !== 'vmess') {
              options.tag = options.inbound.tag;
            }
            return [protocol, createConnectionUrl(options)];
          }),
      ),
    ]),
  );
}
