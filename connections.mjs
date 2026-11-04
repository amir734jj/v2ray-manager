import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import config2vmess from 'v2ray-tools/src/utils/config2vmess.js';
import config2vless from 'v2ray-tools/src/utils/config2vless.js';
import config2trojan from 'v2ray-tools/src/utils/config2trojan.js';
import config2shadowsocks from 'v2ray-tools/src/utils/config2shadowsocks.js';

export const protocols = ['vless', 'vmess', 'trojan', 'shadowsocks'];

export function validateHost(host) {
  if (!host || host === 'YOUR_SERVER_IP') {
    throw new Error('V2RAY_HOST (or the rotation hostname argument) must be your public HTTPS hostname');
  }
  const url = new URL(`https://${host}`);
  if (url.hostname !== host || url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Server address must be a hostname without a scheme, port, or path');
  }
  return host;
}

export function configureServerTransports(config) {
  for (const protocol of protocols) {
    const inbound = config.inbounds.find(i => i.protocol === protocol);
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

function publicStream(inbound, host) {
  return {
    network: 'ws',
    security: 'tls',
    tlsSettings: { serverName: host },
    wsSettings: { path: inbound.streamSettings.wsSettings.path, headers: { Host: host } },
  };
}

export function configureClient(config, serverConfig, host) {
  validateHost(host);
  const proxyOutbounds = (config.outbounds ?? []).filter(o => protocols.includes(o.protocol));
  if (proxyOutbounds.length === 1 && proxyOutbounds[0].protocol === 'shadowsocks') {
    for (const inbound of config.inbounds ?? []) {
      if (inbound.protocol === 'socks') inbound.settings = { ...inbound.settings, udp: false };
    }
  }
  for (const outbound of proxyOutbounds) {
    const inbound = serverConfig.inbounds.find(i => i.protocol === outbound.protocol);
    if (!inbound) throw new Error(`Missing ${outbound.protocol} inbound`);
    outbound.streamSettings = publicStream(inbound, host);
    outbound.mux = { enabled: false };
    if (['vless', 'vmess'].includes(outbound.protocol)) {
      outbound.settings = {
        vnext: [{
          address: host,
          port: 443,
          users: [{
            id: inbound.settings.clients[0].id,
            ...(outbound.protocol === 'vless'
              ? { encryption: 'none' }
              : { alterId: inbound.settings.clients[0].alterId ?? 0, security: 'auto' }),
          }],
        }],
      };
    } else {
      outbound.settings = {
        servers: [{
          address: host,
          port: 443,
          ...(outbound.protocol === 'trojan'
            ? { password: inbound.settings.clients[0].password }
            : { method: inbound.settings.method, password: inbound.settings.password }),
        }],
      };
    }
  }
  return config;
}

export async function createConnectionUrls(serverConfig, host) {
  validateHost(host);
  // URL converters must see the public TLS endpoint, not the internal WS listeners.
  const publicConfig = structuredClone(serverConfig);
  for (const inbound of publicConfig.inbounds) {
    if (!protocols.includes(inbound.protocol)) continue;
    inbound.port = 443;
    inbound.streamSettings = publicStream(inbound, host);
  }
  const dir = await mkdtemp(join(tmpdir(), 'v2ray-connections-'));
  try {
    const serverPath = join(dir, 'server.json');
    const vmessPath = join(dir, 'vmess.json');
    const vmessClient = configureClient({ outbounds: [{ protocol: 'vmess' }] }, serverConfig, host);
    await Promise.all([
      writeFile(serverPath, JSON.stringify(publicConfig)),
      writeFile(vmessPath, JSON.stringify(vmessClient)),
    ]);
    const [vless, vmess, trojan, shadowsocks] = await Promise.all([
      config2vless({ path: serverPath, address: host }),
      config2vmess({ path: vmessPath }),
      config2trojan({ path: serverPath, address: host }),
      config2shadowsocks({ path: serverPath, address: host }),
    ]);
    const urls = { vless, vmess, trojan, shadowsocks };
    for (const [protocol, url] of Object.entries(urls)) {
      if (typeof url !== 'string' || !url.startsWith(`${protocol === 'shadowsocks' ? 'ss' : protocol}://`)) {
        throw new Error(`Failed to generate ${protocol} connection URL`);
      }
    }
    const ssInbound = serverConfig.inbounds.find(i => i.protocol === 'shadowsocks');
    // The core terminates Shadowsocks directly, not the plugin's multiplexing protocol.
    const plugin = `v2ray-plugin;tls;mux=0;host=${host};path=${ssInbound.streamSettings.wsSettings.path}`;
    const [base, fragment] = shadowsocks.split('#');
    urls.shadowsocks = `${base}/?${new URLSearchParams({ plugin })}#${fragment}`;
    return urls;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
