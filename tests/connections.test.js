import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { configureClient, configureServerTransports, createConnectionUrls, protocols } from '../generator/connections.js';

const host = 'proxy.example.com';
const expectedProtocols = ['vless', 'vmess', 'trojan'];
const template = name => JSON.parse(readFileSync(new URL(`../v2ray/templates/${name}.template.json`, import.meta.url), 'utf8'));

test('server and connection URLs support only VLESS, VMess, and Trojan', () => {
  assert.deepEqual(protocols, expectedProtocols);
  const server = configureServerTransports(template('server'));
  assert.deepEqual(server.inbounds.map(inbound => inbound.protocol), expectedProtocols);
  assert.deepEqual(server.inbounds.map(inbound => inbound.port), [53217, 53218, 53219]);
  for (const inbound of server.inbounds) {
    assert.deepEqual(inbound.streamSettings, {
      network: 'ws', security: 'none', wsSettings: { path: `/${inbound.protocol}` },
    });
  }
  const urls = createConnectionUrls(server, host);
  assert.deepEqual(Object.keys(urls), expectedProtocols);
  for (const protocol of expectedProtocols) {
    assert.ok(urls[protocol].startsWith(`${protocol}://`));
  }
});

test('combined and individual client templates retain TLS WebSocket connections', () => {
  const server = configureServerTransports(template('server'));
  for (const name of ['client', ...expectedProtocols]) {
    const client = configureClient(template(name), server, host);
    const proxies = client.outbounds.filter(outbound => expectedProtocols.includes(outbound.protocol));
    assert.deepEqual(proxies.map(outbound => outbound.protocol), name === 'client' ? expectedProtocols : [name]);
    for (const outbound of proxies) {
      assert.deepEqual(outbound.streamSettings, {
        network: 'ws',
        security: 'tls',
        tlsSettings: { serverName: host },
        wsSettings: { path: `/${outbound.protocol}`, headers: { Host: host } },
      });
      const target = (outbound.settings.vnext ?? outbound.settings.servers)[0];
      assert.equal(target.address, host);
      assert.equal(target.port, 443);
    }
    assert.equal(client.outbounds.some(outbound => outbound.protocol === 'shadowsocks'), false);
  }
});

test('regenerating legacy combined configs removes Shadowsocks but preserves other outbounds', () => {
  const server = template('server');
  server.inbounds.push({ protocol: 'shadowsocks', port: 53220 });
  configureServerTransports(server);
  assert.deepEqual(server.inbounds.map(inbound => inbound.protocol), expectedProtocols);

  const client = template('client');
  const direct = client.outbounds.find(outbound => outbound.protocol === 'freedom');
  const blocked = client.outbounds.find(outbound => outbound.protocol === 'blackhole');
  client.outbounds.push({ protocol: 'shadowsocks', tag: 'shadowsocks' });
  configureClient(client, server, host);
  assert.deepEqual(client.outbounds.map(outbound => outbound.protocol), [...expectedProtocols, 'freedom', 'blackhole']);
  assert.ok(client.outbounds.includes(direct));
  assert.ok(client.outbounds.includes(blocked));
});

test('Shadowsocks-only clients are not accepted as supported configurations', () => {
  assert.throws(() => configureClient({
    outbounds: [{ protocol: 'shadowsocks', streamSettings: { network: 'ws' } }],
  }, configureServerTransports(template('server')), host), /Client has no supported proxy outbound/);
});
